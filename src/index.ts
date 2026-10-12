#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sanitizeText } from "./sanitize.js";
import { TTLCache } from "./cache.js";

// Reddit API helper — executes fetch() in Chrome DevTools context
// Requires: chrome-devtools-mcp running + Reddit tab logged in

const server = new McpServer({
  name: "reddit-unofficial-api",
  version: "0.1.0",
});

// ==================== Build identity (kills version skew) ====================
// The running process stamps its own version+sha into ensure_session and the
// startup line, so agents can tell a stale host process from fresh build/.

import { execSync } from "child_process";
import { readFileSync } from "fs";

function buildIdentity(): { bridge_version: string; build_sha: string } {
  // build/index.js -> bridge root is one level up (".."), not two.
  const bridgeRoot = new URL("..", import.meta.url);
  let bridge_version = "unknown";
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("package.json", bridgeRoot), "utf8")
    );
    if (pkg?.version) bridge_version = String(pkg.version);
  } catch {
    // packaged without package.json nearby; keep "unknown"
  }
  let build_sha = "unknown";
  try {
    // cwd must be the bridge checkout: the host process may run anywhere.
    build_sha = execSync("git rev-parse --short HEAD", { cwd: bridgeRoot, timeout: 5000 })
      .toString()
      .trim()
      .slice(0, 12);
  } catch {
    // not a git checkout; keep "unknown"
  }
  return { bridge_version, build_sha };
}

const BUILD = buildIdentity();

// ==================== Configuration ====================

const CHROME_CDP_URL = process.env.CHROME_CDP_URL || "http://localhost:9222";
const RATE_LIMIT_MS = 1500; // delay between write operations
let lastWriteTime = 0;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastWriteTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastWriteTime = Date.now();
}

// Bridge-ready is the binary gate for every tool: CDP answers on
// CHROME_CDP_URL, a reddit.com tab exists, and that tab is logged in.
// Every failure below prefixes its layer so callers stop guessing:
// CDP-unreachable | NO-REDDIT-TAB | NOT-LOGGED-IN | REDDIT-EVAL.

async function checkCdpVersion(): Promise<any> {
  let resp: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      resp = await fetch(`${CHROME_CDP_URL}/json/version`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    throw new Error(
      `CDP-unreachable: curl ${CHROME_CDP_URL}/json/version failed (${e?.message || e}). ` +
      `Start Chrome with --remote-debugging-port=9222, then open reddit.com. See scripts/chrome-bridge.sh.`
    );
  }
  if (!resp.ok) {
    throw new Error(
      `CDP-unreachable: ${CHROME_CDP_URL}/json/version returned HTTP ${resp.status}. ` +
      `Restart Chrome with --remote-debugging-port=9222.`
    );
  }
  return resp.json();
}

async function findRedditTab(): Promise<any> {
  let targetsResp: Response;
  try {
    targetsResp = await fetch(`${CHROME_CDP_URL}/json`);
  } catch (e: any) {
    throw new Error(
      `CDP-unreachable: curl ${CHROME_CDP_URL}/json failed (${e?.message || e}). ` +
      `Start Chrome with --remote-debugging-port=9222. See scripts/chrome-bridge.sh.`
    );
  }
  const targets = await targetsResp.json();

  const redditTab = targets.find((t: any) =>
    t.type === "page" && t.url?.includes("reddit.com")
  );

  if (!redditTab) {
    throw new Error("NO-REDDIT-TAB: no reddit.com tab found in Chrome. Open reddit.com in the debug Chrome window.");
  }
  if (!redditTab.webSocketDebuggerUrl) {
    throw new Error("NO-REDDIT-TAB: reddit.com tab has no debugger URL. Reload the tab and retry.");
  }
  return redditTab;
}

interface CDPResult {
  result: { type: string; value?: any; description?: string };
  exceptionDetails?: any;
}

async function cdpCall(method: string, params: Record<string, any> = {}): Promise<any> {
  // Layered lookup: CDP first, then tab. Each layer throws its own prefix.
  const redditTab = await findRedditTab();

  // Connect via WebSocket
  const ws = new WebSocket(redditTab.webSocketDebuggerUrl);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP call timed out after 30s"));
    }, 30000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data.toString());
      if (data.id === 1) {
        clearTimeout(timeout);
        ws.close();
        if (data.error) {
          reject(new Error(data.error.message));
        } else {
          resolve(data.result);
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error(`CDP WebSocket error: ${err}`));
    };
  });
}

async function evalInReddit(script: string): Promise<any> {
  const result = await cdpCall("Runtime.evaluate", {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
  }) as CDPResult;

  if (result.exceptionDetails) {
    throw new Error(`REDDIT-EVAL: ${result.exceptionDetails.text || result.result?.description}`);
  }
  return result.result?.value;
}

// Compact projection: listing payloads from reddit.com are huge (media
// metadata, award blobs). Default every listing tool to the fields an agent
// actually reads. Pass compact=false for the raw payload.
// All text fields pass sanitizeText (per docs/SANITIZATION.md) before
// truncation. Structural fields (score, comments, link) stay untouched.
function compactChildren(data: any): any[] {
  const kids: any[] = data?.data?.children ?? data?.children ?? [];
  return kids.map((c: any) => {
    const d = c?.data ?? {};
    const item: Record<string, any> = { kind: c?.kind, id: d?.name || d?.id };
    if (d?.permalink) item.link = `https://www.reddit.com${d.permalink}`;
    else if (d?.url) item.link = d.url;
    if (d?.subreddit) item.sub = sanitizeText(d.subreddit, 100);
    if (d?.title) item.title = sanitizeText(d.title, 140);
    if (d?.subject) item.subject = sanitizeText(d.subject, 140);
    if (d?.author) item.author = sanitizeText(d.author, 100);
    if (typeof d?.score === "number") item.score = d.score;
    if (typeof d?.num_comments === "number") item.comments = d.num_comments;
    if (d?.body) item.body = sanitizeText(d.body, 280);
    if (d?.url && d.url !== d?.permalink && d.url !== item.link) item.url = d.url;
    return item;
  });
}

function listingOut(data: any, compact: boolean): string {
  if (!compact) return JSON.stringify(data, null, 2);
  return JSON.stringify(compactChildren(data), null, 1);
}

// Paginated reads trip Reddit's throttle at full speed (429), while ~2s gaps
// stay clean. Pace follow-up page requests inside a single tool call.
const READ_PACE_MS = 2000;
let lastReadTime = 0;

async function paceReads() {
  const now = Date.now();
  const elapsed = now - lastReadTime;
  if (elapsed < READ_PACE_MS) {
    await new Promise(r => setTimeout(r, READ_PACE_MS - elapsed));
  }
  lastReadTime = Date.now();
}

// Subreddit objects (t5) carry no title/body: project the fields that tell
// subs apart instead. Same compact-by-default contract as listings.
function compactSubs(data: any): any[] {
  const kids: any[] = data?.data?.children ?? data?.children ?? [];
  return kids.map((c: any) => {
    const d = c?.data ?? {};
    const name = sanitizeText(d?.display_name || d?.name || "", 100);
    const item: Record<string, any> = { kind: c?.kind, name };
    if (d?.display_name_prefixed) item.prefixed = sanitizeText(d.display_name_prefixed, 120);
    else if (name) item.prefixed = `r/${name}`;
    if (d?.title) item.title = sanitizeText(d.title, 120);
    if (typeof d?.subscribers === "number") item.subscribers = d.subscribers;
    if (typeof d?.over18 === "boolean") item.over18 = d.over18;
    if (name) item.link = `https://www.reddit.com/r/${name}/`;
    return item;
  });
}

// LabeledMulti objects are not listings: project display name, path,
// visibility, and the member subreddit names.
function compactMultis(data: any): any[] {
  const arr: any[] = Array.isArray(data) ? data : [];
  return arr.map((m: any) => {
    const d = m?.data ?? {};
    const subs: string[] = (d?.subreddits ?? []).map((s: any) => sanitizeText(s?.name, 100)).filter(Boolean);
    const item: Record<string, any> = {
      kind: m?.kind,
      name: sanitizeText(d?.name || "", 100),
      display_name: sanitizeText(d?.display_name || d?.name || "", 140),
    };
    if (d?.path) {
      item.path = d.path;
      item.link = `https://www.reddit.com${d.path}`;
    }
    if (typeof d?.visibility === "string") item.visibility = d.visibility;
    item.subCount = subs.length;
    item.subs = subs;
    return item;
  });
}

// TrophyList objects: project trophy name, description, icon.
function compactTrophies(data: any): any[] {
  const t = data?.data?.trophies ?? [];
  return t.map((t: any) => {
    const d = t?.data ?? {};
    return {
      kind: t?.kind,
      name: sanitizeText(d?.name || "", 140),
      description: sanitizeText(d?.description || "", 280),
      icon: d?.icon_70 || d?.icon_40 || "",
    };
  });
}

// Friends (prefs/friends.json): array of UserList objects with children arrays.
function compactFriends(data: any): any[] {
  const lists: any[] = Array.isArray(data) ? data : [];
  return lists.flatMap((list: any) =>
    (list?.data?.children ?? []).map((c: any) => {
      const d = c?.data ?? {};
      return {
        kind: c?.kind,
        name: sanitizeText(d?.name || d?.id || "", 100),
        id: d?.id || "",
        date: d?.date || 0,
      };
    })
  );
}

// Moderator subreddits (subreddits/mine/moderator.json): listing of subreddits.
function compactModOf(data: any): any[] {
  const kids: any[] = data?.data?.children ?? data?.children ?? [];
  return kids.map((c: any) => {
    const d = c?.data ?? {};
    const name = sanitizeText(d?.display_name || d?.name || "", 100);
    return {
      kind: c?.kind,
      name,
      prefixed: sanitizeText(d?.display_name_prefixed || (name ? `r/${name}` : ""), 120),
      subscribers: d?.subscribers,
      over18: d?.over18,
      link: name ? `https://www.reddit.com/r/${name}/` : "",
    };
  });
}

// ==================== Reddit API Helpers ====================

// Per-PRD 5.1 cache TTLs (seconds). Env-overridable.
const TTL_FEED = Number(process.env.CACHE_TTL_SECONDS || "120");
const TTL_INBOX = Number(process.env.CACHE_TTL_INBOX_SECONDS || "30");
const TTL_POST = Number(process.env.CACHE_TTL_POST_SECONDS || "300");
const cache = new TTLCache();

async function getModhash(): Promise<string> {
  const result = await evalInReddit(`
    (async () => {
      const resp = await fetch('https://www.reddit.com/api/me.json', { credentials: 'include' });
      const data = await resp.json();
      return data.data?.modhash || '';
    })()
  `);
  if (!result) throw new Error("NOT-LOGGED-IN: could not get modhash. Log in to Reddit in the debug Chrome window.");
  return result;
}

async function redditGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = `https://www.reddit.com${path}${qs ? '?' + qs : ''}`;

  return evalInReddit(`
    (async () => {
      const resp = await fetch('${url}', { credentials: 'include' });
      if (!resp.ok) return { error: resp.status, statusText: resp.statusText };
      return await resp.json();
    })()
  `);
}

// Cached listing GET: PRD 4 stage 1 (rate-limit/cache check). Never caches
// error payloads; session probes (me.json) stay on uncached redditGet.
async function redditGetCached(path: string, params: Record<string, string> = {}, ttl: number = TTL_FEED): Promise<any> {
  const hit = cache.get(path, params);
  if (hit !== undefined) return hit;
  const data = await redditGet(path, params);
  if (!data?.error) cache.set(path, params, data, ttl);
  return data;
}

async function redditPost(path: string, params: Record<string, string>): Promise<any> {
  await rateLimit();
  const modhash = await getModhash();
  params.uh = modhash;
  params.api_type = "json";

  const body = new URLSearchParams(params).toString();

  const result = evalInReddit(`
    (async () => {
      const resp = await fetch('https://www.reddit.com${path}', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '${body.replace(/'/g, "\\'")}'
      });
      const text = await resp.text();
      try { return JSON.parse(text); } catch(e) { return { error: 'parse_error', raw: text.substring(0, 500) }; }
    })()
  `);
  cache.clear(); // any write invalidates cached reads (scores, listings, state)
  return result;
}

// JSON-body POST/PUT/DELETE for endpoints that take structured bodies
// (multi create/update/delete). Reddit's multi API is quirky: the payload
// rides a form-encoded `model` field (a stringified LabeledMulti), with the
// modhash in the X-Modhash header. Plain JSON bodies return JSON_PARSE_ERROR.
async function redditForm(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  params: Record<string, string> = {}
): Promise<any> {
  await rateLimit();
  const modhash = await getModhash();
  const body = new URLSearchParams(params).toString();

  const result = evalInReddit(`
    (async () => {
      const resp = await fetch('https://www.reddit.com${path}', {
        method: '${method}',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Modhash': '${modhash}' },
        body: '${body.replace(/'/g, "\\'")}'
      });
      const text = await resp.text();
      if (!text) return null; // DELETE returns empty body on success
      try { return JSON.parse(text); } catch(e) { return { error: 'parse_error', status: resp.status, raw: text.substring(0, 500) }; }
    })()
  `);
  cache.clear();
  return result;
}

// ==================== MCP Tools ====================

// --- Read Operations ---

server.tool(
  "reddit_me",
  "Get current logged-in Reddit user info",
  {},
  async () => {
    const data = await redditGet("/api/me.json");
    return { content: [{ type: "text", text: JSON.stringify(data.data || data, null, 2) }] };
  }
);

server.tool(
  "reddit_get_post",
  "Get a Reddit post and its comments (compact projection by default)",
  {
    url: z.string().describe("Reddit post URL or post ID (e.g. '1sdv3lo')"),
    sort: z.enum(["top", "new", "best", "controversial", "old", "qa"]).default("top").describe("Comment sort order"),
    limit: z.number().default(100).describe("Max comments to return"),
    compact: z.boolean().default(true).describe("Project to sub/title/author/score/comments/body only. False returns the raw payload."),
  },
  async ({ url, sort, limit, compact }) => {
    // Extract post ID from URL
    const match = url.match(/comments\/([a-z0-9]+)/);
    const postId = match ? match[1] : url;

    const data = await redditGetCached(`/comments/${postId}.json`, { sort, limit: String(limit) }, TTL_POST);

    if (Array.isArray(data) && data.length >= 2) {
      if (!compact) {
        const post = data[0]?.data?.children?.[0]?.data;
        const comments = data[1]?.data?.children?.map((c: any) => c.data) || [];
        return { content: [{ type: "text", text: JSON.stringify({ post, comments }, null, 2) }] };
      }
      const post = compactChildren(data[0])[0];
      const comments = compactChildren(data[1]);
      return { content: [{ type: "text", text: JSON.stringify({ post, comments }, null, 1) }] };
    }
    return { content: [{ type: "text", text: listingOut(data, compact) }] };
  }
);

server.tool(
  "reddit_get_comments",
  "Get all comments for a post as a flat list with author, body, score, and parent info",
  {
    url: z.string().describe("Reddit post URL or post ID"),
    sort: z.enum(["top", "new", "best", "controversial", "old", "qa"]).default("top"),
  },
  async ({ url, sort }) => {
    const match = url.match(/comments\/([a-z0-9]+)/);
    const postId = match ? match[1] : url;

    const data = await redditGetCached(`/comments/${postId}.json`, { sort, limit: "500" }, TTL_POST);

    if (!Array.isArray(data) || data.length < 2) {
      return { content: [{ type: "text", text: "Could not fetch comments" }] };
    }

    // Flatten comment tree
    const flat: any[] = [];
    function extract(children: any[], depth: number = 0) {
      for (const child of children) {
        if (child.kind !== "t1") continue;
        const c = child.data;
        flat.push({
          id: c.name,
          author: c.author,
          body: c.body,
          score: c.score,
          parent_id: c.parent_id,
          depth,
          created_utc: c.created_utc,
        });
        if (c.replies?.data?.children) {
          extract(c.replies.data.children, depth + 1);
        }
      }
    }
    extract(data[1].data.children);

    return { content: [{ type: "text", text: JSON.stringify(flat, null, 2) }] };
  }
);

server.tool(
  "reddit_get_user",
  "Get a Reddit user's profile, posts, or comments (compact projection by default)",
  {
    username: z.string().describe("Reddit username, or 'me' for the logged-in account"),
    type: z
      .enum([
        "about",
        "overview",
        "submitted",
        "comments",
        "controversial",
        "trophies",
        "friends",
        "moderator",
        "upvoted",
        "downvoted",
        "saved",
        "hidden",
      ])
      .default("about")
      .describe(
        "upvoted, downvoted, saved, hidden, controversial, trophies, friends, and moderator are private to the logged-in account: pass username 'me' or your own name."
      ),
    limit: z.number().default(25),
    compact: z.boolean().default(true).describe("Project to sub/title/author/score/comments/body only. False returns the raw payload."),
  },
  async ({ username, type, limit, compact }) => {
    let path: string;
    if (type === "about") {
      path = `/user/${username}/about.json`;
      const data = await redditGetCached(path, {}, TTL_FEED);
      if (!compact) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      // about.json returns a single t2 object, not a listing — return as-is
      return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
    }
    if (type === "trophies") {
      path = `/user/${username}/trophies.json`;
      const data = await redditGetCached(path, {}, TTL_FEED);
      if (!compact) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      return { content: [{ type: "text", text: JSON.stringify(compactTrophies(data), null, 1) }] };
    }
    if (type === "friends") {
      path = `/prefs/friends.json`;
      const data = await redditGetCached(path, {}, TTL_FEED);
      if (!compact) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      return { content: [{ type: "text", text: JSON.stringify(compactFriends(data), null, 1) }] };
    }
    if (type === "moderator") {
      path = `/subreddits/mine/moderator.json`;
      const data = await redditGetCached(path, {}, TTL_FEED);
      if (!compact) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      return { content: [{ type: "text", text: JSON.stringify(compactModOf(data), null, 1) }] };
    }
    // listing types: overview, submitted, comments, controversial, upvoted, downvoted, saved, hidden
    path = `/user/${username}/${type}.json`;
    const data = await redditGetCached(path, { limit: String(limit) }, TTL_FEED);
    return { content: [{ type: "text", text: listingOut(data, compact) }] };
  }
);

server.tool(
  "reddit_get_subreddit",
  "Get subreddit info, rules, or posts (compact projection by default)",
  {
    subreddit: z.string().describe("Subreddit name (without r/)"),
    type: z.enum(["about", "rules", "hot", "new", "top", "rising"]).default("hot"),
    limit: z.number().default(25),
    time: z.enum(["hour", "day", "week", "month", "year", "all"]).default("day").describe("Time filter for top/controversial"),
    compact: z.boolean().default(true).describe("Project to sub/title/author/score/comments/body only. False returns the raw payload."),
  },
  async ({ subreddit, type, limit, time, compact }) => {
    const path = ["about", "rules"].includes(type)
      ? `/r/${subreddit}/about/${type === "about" ? "" : "rules"}.json`
      : `/r/${subreddit}/${type}.json`;
    const data = await redditGetCached(path, { limit: String(limit), t: time }, TTL_FEED);
    return { content: [{ type: "text", text: listingOut(data, compact) }] };
  }
);

server.tool(
  "reddit_search",
  "Search Reddit posts within a subreddit (compact projection by default). Subreddit is required: global search returns junk (CODING_STANDARDS 8.3).",
  {
    query: z.string().describe("Search query"),
    subreddit: z.string().describe("Subreddit to search (required, without r/)"),
    sort: z.enum(["relevance", "hot", "top", "new", "comments"]).default("relevance"),
    time: z.enum(["hour", "day", "week", "month", "year", "all"]).default("all"),
    limit: z.number().default(25),
    compact: z.boolean().default(true).describe("Project to sub/title/author/score/comments/body only. False returns the raw payload."),
  },
  async ({ query, subreddit, sort, time, limit, compact }) => {
    const path = `/r/${subreddit}/search.json`;
    const params: Record<string, string> = { q: query, sort, t: time, limit: String(limit), restrict_sr: "on" };
    const data = await redditGetCached(path, params, TTL_FEED);
    return { content: [{ type: "text", text: listingOut(data, compact) }] };
  }
);

server.tool(
  "reddit_get_inbox",
  "Get Reddit messages (inbox, unread, sent, comment replies, post replies, or mentions) (compact projection by default)",
  {
    type: z.enum(["inbox", "unread", "sent", "comments", "selfreply", "mentions"]).default("unread").describe("comments = replies to your comments, selfreply = replies to your posts, mentions = username mentions."),
    limit: z.number().default(25),
    compact: z.boolean().default(true).describe("Project to sub/title/author/score/comments/body only. False returns the raw payload."),
  },
  async ({ type, limit, compact }) => {
    const data = await redditGetCached(`/message/${type}.json`, { limit: String(limit) }, TTL_INBOX);
    return { content: [{ type: "text", text: listingOut(data, compact) }] };
  }
);

server.tool(
  "reddit_get_subscriptions",
  "List the subreddits the logged-in account subscribes to (compact projection by default)",
  {
    limit: z.number().default(100).describe("Max subreddits to return (server pages through the listing up to this cap)"),
    compact: z.boolean().default(true).describe("Project to name/title/subscribers/over18/link only. False returns the raw payload."),
  },
  async ({ limit, compact }) => {
    const cap = Math.min(Math.max(limit, 1), 100);
    const perPage = 25;
    const all: any[] = [];
    let after = "";
    let rawFirstPage: any = null;
    for (let page = 0; page < 4 && all.length < cap; page++) {
      if (page > 0) await paceReads();
      const params: Record<string, string> = { limit: String(Math.min(perPage, cap - all.length)) };
      if (after) params.after = after;
      const data = await redditGetCached("/subreddits/mine/subscriber.json", params, TTL_FEED);
      if (data?.error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: data.error, statusText: data.statusText }) }] };
      }
      if (page === 0) rawFirstPage = data;
      const kids: any[] = data?.data?.children ?? [];
      all.push(...kids);
      after = data?.data?.after || "";
      if (!after) break;
    }
    if (!compact && rawFirstPage) {
      // For raw, return the first page's actual Reddit payload (what the API returns)
      // with a note about additional pages if we fetched more
      return { content: [{ type: "text", text: JSON.stringify(rawFirstPage, null, 2) }] };
    }
    const out = { data: { children: all.slice(0, cap), after: after || null } };
    return { content: [{ type: "text", text: JSON.stringify(compactSubs(out), null, 1) }] };
  }
);

server.tool(
  "reddit_get_multis",
  "List the logged-in account's multis (custom feeds): display name, path, visibility, member subreddits",
  {
    compact: z.boolean().default(true).describe("Project to name/path/visibility/subreddit names only. False returns the raw payload."),
  },
  async ({ compact }) => {
    const data = await redditGetCached("/api/multi/mine.json", {}, TTL_FEED);
    if (!Array.isArray(data)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: data?.error || "unexpected response", statusText: data?.statusText }) }] };
    }
    if (!compact) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    return { content: [{ type: "text", text: JSON.stringify(compactMultis(data), null, 1) }] };
  }
);

server.tool(
  "reddit_get_multi_feed",
  "Read posts from one of the logged-in account's multis (custom feeds) (compact projection by default)",
  {
    multi: z.string().describe("Multi name (e.g. 'favoritos') or full path ('/user/<name>/m/<multi>'). Resolved against your multis, case-insensitive."),
    limit: z.number().default(25).describe("Max posts to return (server pages through the listing up to this cap, max 100)"),
    compact: z.boolean().default(true).describe("Project to sub/title/author/score/comments/link only. False returns the raw payload."),
  },
  async ({ multi, limit, compact }) => {
    let path = multi.trim();
    if (!path.startsWith("/user/")) {
      const mine = await redditGetCached("/api/multi/mine.json", {}, TTL_FEED);
      if (!Array.isArray(mine)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "could not list your multis", statusText: mine?.statusText }) }] };
      }
      const want = path.toLowerCase();
      const hit = mine.find((m: any) =>
        String(m?.data?.name || "").toLowerCase() === want ||
        String(m?.data?.display_name || "").toLowerCase() === want
      );
      if (!hit?.data?.path) {
        const names = mine.map((m: any) => m?.data?.name).filter(Boolean);
        return { content: [{ type: "text", text: JSON.stringify({ error: `no multi named '${multi}'`, your_multis: names }) }] };
      }
      path = hit.data.path;
    }
    // Pace the initial multi listing read
    await paceReads();
    const cap = Math.min(Math.max(limit, 1), 100);
    const perPage = 25;
    const all: any[] = [];
    let after = "";
    let rawFirstPage: any = null;
    for (let page = 0; page < 4 && all.length < cap; page++) {
      if (page > 0) await paceReads();
      const params: Record<string, string> = { limit: String(Math.min(perPage, cap - all.length)) };
      if (after) params.after = after;
      const data = await redditGetCached(`${path}.json`, params, TTL_FEED);
      if (data?.error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: data.error, statusText: data.statusText }) }] };
      }
      if (page === 0) rawFirstPage = data;
      const kids: any[] = data?.data?.children ?? [];
      all.push(...kids);
      after = data?.data?.after || "";
      if (!after) break;
    }
    if (!compact && rawFirstPage) {
      return { content: [{ type: "text", text: JSON.stringify(rawFirstPage, null, 2) }] };
    }
    const out = { data: { children: all.slice(0, cap), after: after || null } };
    return { content: [{ type: "text", text: JSON.stringify(compactChildren(out), null, 1) }] };
  }
);

server.tool(
  "reddit_comment",
  "Reply to a Reddit post or comment",
  {
    thing_id: z.string().describe("Fullname of parent (t1_ for comment, t3_ for post)"),
    text: z.string().describe("Comment text (markdown supported)"),
  },
  async ({ thing_id, text }) => {
    const result = await redditPost("/api/comment", { thing_id, text });
    const success = !result.json?.errors?.length;
    const commentId = result.json?.data?.things?.[0]?.data?.id;
    return {
      content: [{ type: "text", text: JSON.stringify({ success, commentId, errors: result.json?.errors }) }]
    };
  }
);

server.tool(
  "reddit_submit",
  "Create a new Reddit post",
  {
    subreddit: z.string().describe("Subreddit name (without r/)"),
    title: z.string().describe("Post title"),
    kind: z.enum(["self", "link"]).describe("Post type: self (text) or link"),
    text: z.string().optional().describe("Post body text (for self posts)"),
    url: z.string().optional().describe("URL (for link posts)"),
    flair_id: z.string().optional().describe("Flair template ID"),
    flair_text: z.string().optional().describe("Flair text"),
    nsfw: z.boolean().default(false),
    spoiler: z.boolean().default(false),
  },
  async ({ subreddit, title, kind, text, url, flair_id, flair_text, nsfw, spoiler }) => {
    const params: Record<string, string> = { sr: subreddit, title, kind };
    if (text) params.text = text;
    if (url) params.url = url;
    if (flair_id) params.flair_id = flair_id;
    if (flair_text) params.flair_text = flair_text;
    if (nsfw) params.nsfw = "true";
    if (spoiler) params.spoiler = "true";
    params.sendreplies = "true";
    params.resubmit = "true";

    const result = await redditPost("/api/submit", params);
    return { content: [{ type: "text", text: JSON.stringify(result.json || result, null, 2) }] };
  }
);

server.tool(
  "reddit_vote",
  "Upvote, downvote, or unvote on a post or comment",
  {
    thing_id: z.string().describe("Fullname (t1_ or t3_)"),
    direction: z.enum(["up", "down", "unvote"]).describe("Vote direction"),
  },
  async ({ thing_id, direction }) => {
    const dir = direction === "up" ? "1" : direction === "down" ? "-1" : "0";
    const result = await redditPost("/api/vote", { id: thing_id, dir });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, direction }) }] };
  }
);

server.tool(
  "reddit_save",
  "Save or unsave a Reddit post or comment",
  {
    thing_id: z.string().describe("Fullname (t1_ or t3_)"),
    unsave: z.boolean().default(false).describe("Set true to unsave"),
  },
  async ({ thing_id, unsave }) => {
    const path = unsave ? "/api/unsave" : "/api/save";
    await redditPost(path, { id: thing_id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, action: unsave ? "unsaved" : "saved" }) }] };
  }
);

server.tool(
  "reddit_send_message",
  "Send a Reddit private message",
  {
    to: z.string().describe("Username to send to"),
    subject: z.string().describe("Message subject"),
    text: z.string().describe("Message body"),
  },
  async ({ to, subject, text }) => {
    const result = await redditPost("/api/compose", { to, subject, text });
    return { content: [{ type: "text", text: JSON.stringify(result.json || result, null, 2) }] };
  }
);

server.tool(
  "reddit_edit",
  "Edit your own post or comment",
  {
    thing_id: z.string().describe("Fullname of your post/comment to edit"),
    text: z.string().describe("New text content"),
  },
  async ({ thing_id, text }) => {
    const result = await redditPost("/api/editusertext", { thing_id, text });
    return { content: [{ type: "text", text: JSON.stringify(result.json || result, null, 2) }] };
  }
);

server.tool(
  "reddit_delete",
  "Delete your own post or comment",
  {
    thing_id: z.string().describe("Fullname of your post/comment to delete"),
  },
  async ({ thing_id }) => {
    await redditPost("/api/del", { id: thing_id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted: thing_id }) }] };
  }
);

server.tool(
  "reddit_subscribe",
  "Subscribe or unsubscribe to a subreddit",
  {
    subreddit: z.string().describe("Subreddit name"),
    unsubscribe: z.boolean().default(false),
  },
  async ({ subreddit, unsubscribe }) => {
    const action = unsubscribe ? "unsub" : "sub";
    await redditPost("/api/subscribe", { action, sr_name: subreddit });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, action, subreddit }) }] };
  }
);

server.tool(
  "reddit_hide",
  "Hide or unhide a post (hidden posts disappear from your feeds; reversible)",
  {
    thing_id: z.string().describe("Post fullname (t3_)"),
    unhide: z.boolean().default(false).describe("Set true to unhide"),
  },
  async ({ thing_id, unhide }) => {
    const path = unhide ? "/api/unhide" : "/api/hide";
    await redditPost(path, { id: thing_id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, action: unhide ? "unhidden" : "hidden", thing_id }) }] };
  }
);

server.tool(
  "reddit_multi_create",
  "Create a new multi (custom feed) with member subreddits",
  {
    name: z.string().describe("Multi name: lowercase letters, numbers, underscores only (no hyphens/spaces)"),
    subreddits: z.array(z.string()).describe("Subreddit names (without r/)"),
    description: z.string().optional().describe("Multi description"),
    visibility: z.enum(["private", "public", "hidden"]).default("private"),
  },
  async ({ name, subreddits, description, visibility }) => {
    const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const me = await redditGet("/api/me.json");
    const owner = me?.data?.name;
    if (!owner) return { content: [{ type: "text", text: JSON.stringify({ error: "NOT-LOGGED-IN" }) }] };

    const model: Record<string, any> = {
      name: safeName,
      path: `user:${owner}/m/${safeName}`,
      visibility,
      subreddits: subreddits.map((s) => ({ name: s })),
    };
    if (description) model.description_md = description;
    const result = await redditForm("PUT", `/api/multi/user/${owner}/m/${safeName}`, {
      model: JSON.stringify(model),
      api_type: "json",
    });
    const ok = result?.kind === "LabeledMulti" && !result?.error && !result?.reason;
    return { content: [{ type: "text", text: JSON.stringify({ success: ok, name: safeName, subCount: subreddits.length, result: ok ? "created" : result }) }] };
  }
);

server.tool(
  "reddit_multi_update",
  "Update one of your multis: add or remove member subreddits, change description",
  {
    multi: z.string().describe("Multi name (e.g. 'favoritos')"),
    add_subs: z.array(z.string()).optional().describe("Subreddit names to add"),
    remove_subs: z.array(z.string()).optional().describe("Subreddit names to remove"),
    description: z.string().optional().describe("New description"),
  },
  async ({ multi, add_subs, remove_subs, description }) => {
    const me = await redditGet("/api/me.json");
    const owner = me?.data?.name;
    if (!owner) return { content: [{ type: "text", text: JSON.stringify({ error: "NOT-LOGGED-IN" }) }] };

    const safeName = multi.trim().toLowerCase();
    // Current membership
    const current = await redditGet(`/api/multi/user/${owner}/m/${safeName}`);
    if (current?.error || current?.reason) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `could not read multi '${safeName}'`, detail: current?.reason || current?.error }) }] };
    }
    const names: string[] = ((current?.data?.subreddits ?? current?.subreddits) ?? []).map((s: any) => s.name);
    const add = add_subs ?? [];
    const remove = remove_subs ?? [];
    const next = [...new Set([...names.filter((n) => !remove.includes(n)), ...add])];

    const model: Record<string, any> = {
      name: safeName,
      path: `user:${owner}/m/${safeName}`,
      subreddits: next.map((s) => ({ name: s })),
    };
    if (description) model.description_md = description;
    const result = await redditForm("PUT", `/api/multi/user/${owner}/m/${safeName}`, {
      model: JSON.stringify(model),
      api_type: "json",
    });
    const ok = result?.kind === "LabeledMulti" && !result?.error && !result?.reason;
    return { content: [{ type: "text", text: JSON.stringify({ success: ok, multi: safeName, before: names.length, after: next.length, added: add, removed: remove.filter((r) => names.includes(r)) }) }] };
  }
);

server.tool(
  "reddit_multi_delete",
  "Delete one of your multis (cannot be undone)",
  {
    multi: z.string().describe("Multi name to delete"),
  },
  async ({ multi }) => {
    const me = await redditGet("/api/me.json");
    const owner = me?.data?.name;
    if (!owner) return { content: [{ type: "text", text: JSON.stringify({ error: "NOT-LOGGED-IN" }) }] };
    const safeName = multi.trim().toLowerCase();
    const result = await redditForm("DELETE", `/api/multi/user/${owner}/m/${safeName}`);
    const failed = result?.reason || result?.error;
    return { content: [{ type: "text", text: JSON.stringify({ success: !failed, deleted: safeName, detail: failed || "ok" }) }] };
  }
);

// --- Utility ---

server.tool(
  "reddit_ensure_session",
  "Check bridge-ready: CDP answers, reddit.com tab exists, user is logged in. Probe this before any other reddit_* tool.",
  {},
  async () => {
    const state: Record<string, any> = {
      bridge_ready: false,
      cdp_reachable: false,
      chrome_version: null,
      reddit_tab_found: false,
      logged_in: false,
      username: null,
      bridge_version: BUILD.bridge_version,
      build_sha: BUILD.build_sha,
      cdp_url: CHROME_CDP_URL,
    };
    try {
      const version = await checkCdpVersion();
      state.cdp_reachable = true;
      state.chrome_version = version?.Browser || version?.["User-Agent"] || "unknown";
    } catch (e: any) {
      state.error = e.message;
      state.hint = "Run scripts/chrome-bridge.sh, then open reddit.com in that window.";
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
    }
    try {
      await findRedditTab();
      state.reddit_tab_found = true;
    } catch (e: any) {
      state.error = e.message;
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
    }
    try {
      const data = await redditGet("/api/me.json");
      const username = data?.data?.name;
      if (username) {
        state.logged_in = true;
        state.username = username;
        state.bridge_ready = true;
        state.message = `bridge-ready: logged in as u/${username}`;
      } else {
        state.error = "NOT-LOGGED-IN: reddit.com tab found but no user. Log in to Reddit in Chrome.";
      }
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
    } catch (e: any) {
      state.error = e.message;
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
    }
  }
);

// ==================== Start Server ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `reddit-unofficial-api MCP server running version=${BUILD.bridge_version} sha=${BUILD.build_sha} cdp=${CHROME_CDP_URL}`
  );
}

main().catch(console.error);
