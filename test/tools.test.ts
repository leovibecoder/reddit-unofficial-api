// Tool registration + parameter validation — boots the built bridge over
// stdio (same handshake as scripts/reddit-doctor.sh). Validation tests
// stay offline: zod rejects bad params before any handler (and any CDP
// call) runs; the empty-ID and bad-ID paths return before any POST.
// Skips when build/ is absent (fresh clone); the pre-commit hook runs
// tests without building first, so a hard failure there would break it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BUILD_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "index.js");

interface ToolEntry {
  name?: unknown;
}

interface CallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

interface JsonRpcMsg {
  id?: number | null;
  result?: CallResult;
  error?: unknown;
}

function bodyText(res: CallResult): Record<string, unknown> {
  return JSON.parse(res.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

class BridgeClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, (m: JsonRpcMsg) => void>();

  constructor() {
    this.child = spawn("node", [BUILD_JS], { stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString();
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(line) as JsonRpcMsg;
      } catch {
        continue; // ignore non-JSON stdout
      }
      if (typeof msg?.id === "number") this.pending.get(msg.id)?.(msg);
    }
  }

  call(method: string, params?: unknown): Promise<JsonRpcMsg> {
    const id = this.nextId++;
    const req: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) req.params = params;
    return new Promise<JsonRpcMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 25000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(m);
      });
      this.child.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async init(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tools-test", version: "0" },
    });
    this.notify("notifications/initialized");
  }

  close(): void {
    this.child.kill();
  }
}

async function toolCall(client: BridgeClient, name: string, args: unknown): Promise<CallResult> {
  const msg = await client.call("tools/call", { name, arguments: args });
  return (msg.result ?? {}) as CallResult;
}

describe.skipIf(!existsSync(BUILD_JS))("bridge tools (needs build/index.js — run npm run build first)", () => {
  let client!: BridgeClient;

  beforeAll(async () => {
    client = new BridgeClient();
    await client.init();
  }, 30000);

  afterAll(() => client.close());

  it("registers the documented tools", async () => {
    const msg = await client.call("tools/list", {});
    const tools = (msg.result as { tools?: ToolEntry[] } | undefined)?.tools ?? [];
    const names = tools.map((t) => String(t?.name));
    expect(names).toEqual(
      expect.arrayContaining(["reddit_ensure_session", "reddit_get_home_feed", "reddit_mark_notifications_as_read"])
    );
    // Snapshot pins the full list: any added/removed/renamed tool fails
    // loudly and forces an explicit snapshot update alongside the README.
    expect(names.sort()).toMatchSnapshot();
  }, 30000);

  it("home_feed rejects a bad sort", async () => {
    const res = await toolCall(client, "reddit_get_home_feed", { sort: "bogus" });
    expect(res.isError).toBe(true);
  });

  it("home_feed rejects out-of-range limit", async () => {
    for (const limit of [0, 51]) {
      const res = await toolCall(client, "reddit_get_home_feed", { limit });
      expect(res.isError).toBe(true);
    }
  });

  it("home_feed rejects a non-numeric limit", async () => {
    const res = await toolCall(client, "reddit_get_home_feed", { limit: "25" });
    expect(res.isError).toBe(true);
  });

  it("mark-read with empty IDs succeeds without a write", async () => {
    const res = await toolCall(client, "reddit_mark_notifications_as_read", { notification_ids: [] });
    expect(res.isError).toBeFalsy();
    expect(bodyText(res)).toEqual({ success: true, count: 0 });
  });

  it("mark-read rejects malformed IDs before any POST", async () => {
    const res = await toolCall(client, "reddit_mark_notifications_as_read", {
      notification_ids: ["bogus", "t3_abc"],
    });
    expect(res.isError).toBeFalsy();
    const body = bodyText(res);
    expect(body.success).toBe(false);
    expect(String(body.error)).toContain("bogus");
  });

  it("mark-read rejects a non-array", async () => {
    const res = await toolCall(client, "reddit_mark_notifications_as_read", { notification_ids: "t4_abc" });
    expect(res.isError).toBe(true);
  });
});
