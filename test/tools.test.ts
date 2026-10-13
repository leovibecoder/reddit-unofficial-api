// Tool registration smoke test — boots the built bridge over stdio and
// asserts the documented tools are actually registered. Catches skew
// between src/README (what we claim) and build/index.js (what the host
// loads). Skips when build/ is absent (fresh clone); the pre-commit hook
// runs tests without building first, so a hard failure there would break it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BUILD_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "index.js");

interface ToolEntry {
  name?: unknown;
}

async function listToolNames(): Promise<string[]> {
  const child = spawn("node", [BUILD_JS], { stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const gotNames = new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tools/list timed out")), 25000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        let msg: { id?: unknown; result?: { tools?: unknown } } | null = null;
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue; // startup line goes to stderr; ignore non-JSON stdout
        }
        if (msg?.id === 2 && Array.isArray(msg?.result?.tools)) {
          clearTimeout(timer);
          resolve((msg.result.tools as ToolEntry[]).map((t) => String(t?.name)));
        }
      }
    });
    child.on("error", reject);
  });
  const req = (id: number | null, method: string, params?: unknown) =>
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        ...(id === null ? {} : { id }),
        method,
        ...(params === undefined ? {} : { params }),
      }) + "\n"
    );
  try {
    // Same handshake sequence as scripts/reddit-doctor.sh (proven to work).
    req(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tools-test", version: "0" },
    });
    req(null, "notifications/initialized");
    req(2, "tools/list", {});
    return await gotNames;
  } finally {
    child.kill();
  }
}

describe.skipIf(!existsSync(BUILD_JS))("tool registration (needs build/index.js — run npm run build first)", () => {
  it("registers the documented tools", async () => {
    const names = await listToolNames();
    expect(names).toEqual(
      expect.arrayContaining(["reddit_ensure_session", "reddit_get_home_feed", "reddit_mark_notifications_as_read"])
    );
    // Snapshot pins the full list: any added/removed/renamed tool fails
    // loudly and forces an explicit snapshot update alongside the README.
    expect(names.sort()).toMatchSnapshot();
  }, 30000);
});
