#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import CDP from "chrome-remote-interface";

// Reddit Unofficial API — MCP Server
// Executes fetch() in Chrome's Reddit tab context via CDP
// Requires: Chrome with --remote-debugging-port=9222 + Reddit tab logged in

const server = new McpServer({
  name: "reddit-unofficial-api",
  version: "0.1.0",
});

// ==================== Configuration ====================

const CDP_HOST = process.env.CHROME_CDP_HOST || "localhost";
const CDP_PORT = parseInt(process.env.CHROME_CDP_PORT || "9222", 10);
const RATE_LIMIT_MS = 1500;
let lastWriteTime = 0;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastWriteTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastWriteTime = Date.now();
}

// ==================== CDP Connection ====================

let cachedClient: CDP.Client | null = null;
let cachedTargetId: string | null = null;

async function findRedditTarget(): Promise<CDP.Target> {
  let targets: CDP.Target[];
  try {
    targets = await CDP.List({ host: CDP_HOST, port: CDP_PORT });
  } catch (e: any) {
    throw new Error(
      `Cannot connect to Chrome DevTools at ${CDP_HOST}:${CDP_PORT}. ` +
        `Start Chrome with: google-chrome --remote-debugging-port=${CDP_PORT}`
    );
  }

  const redditTab = targets.find(
    (t: any) => t.type === "page" && t.url?.includes("reddit.com")
  );

  if (!redditTab) {
    throw new Error(
      "No Reddit tab found in Chrome. Open reddit.com and log in first."
    );
  }

  return redditTab;
}

async function getClient(): Promise<CDP.Client> {
  // Reuse connection if target hasn't changed
  if (cachedClient && cachedTargetId) {
    try {
      // Quick health check — if the tab closed, this will fail
      await cachedClient.Runtime.evaluate({ expression: "1" });
      return cachedClient;
    } catch {
      // Connection stale, reconnect
      try {
        await cachedClient.close();
      } catch {
        /* already dead */
      }
      cachedClient = null;
      cachedTargetId = null;
    }
  }

  const target = await findRedditTarget();
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target });
  await client.Runtime.enable();

  cachedClient = client;
  cachedTargetId = target.id;
  return client;
}

async function evalInReddit(script: string): Promise<any> {
  const client = await getClient();

  const result = await client.Runtime.evaluate({
    expression: script,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    const msg =
      result.exceptionDetails.text ||
      result.result?.description ||
      "Unknown eval error";
    throw new Error(`Reddit eval error: ${msg}`);
  }

  return result.result?.value;
}

// ==================== Reddit API Helpers ====================

async function getModhash(): Promise<string> {
  const result = await evalInReddit(`
    (async () => {
      const resp = await fetch('https://www.reddit.com/api/me.json', { credentials: 'include' });
      const data = await resp.json();
      return data.data?.modhash || '';
    })()
  `);
  if (!result) {
    throw new Error(
      "Could not get modhash — you may not be logged in to Reddit. " +
        "Open reddit.com in Chrome and log in."
    );
  }
  return result;
}

async function redditGet(
  path: string,
  params: Record<string, string> = {}
): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = `https://www.reddit.com${path}${qs ? "?" + qs : ""}`;

  const result = await evalInReddit(`
    (async () => {
      const resp = await fetch('${url}', { credentials: 'include' });
      if (resp.status === 429) return { error: 'rate_limited', status: 429 };
      if (!resp.ok) return { error: resp.status, statusText: resp.statusText };
      return await resp.json();
    })()
  `);

  if (result?.error === "rate_limited") {
    throw new Error(
      "Reddit rate limited this request. Wait a few minutes and try again."
    );
  }
  if (result?.error && typeof result.error === "number") {
    throw new Error(`Reddit API returned HTTP ${result.error}: ${result.statusText}`);
  }

  return result;
}

async function redditPost(
  path: string,
  params: Record<string, string>
): Promise<any> {
  await rateLimit();
  const modhash = await getModhash();
  params.uh = modhash;
  params.api_type = "json";

  const body = new URLSearchParams(params).toString();

  const result = await evalInReddit(`
    (async () => {
      const resp = await fetch('https://www.reddit.com${path}', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '${body.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'
      });
      if (resp.status === 429) return { json: { errors: [['RATELIMIT', 'Rate limited by Reddit. Wait a few minutes.']] } };
      const text = await resp.text();
      try { return JSON.parse(text); } catch(e) { return { error: 'parse_error', raw: text.substring(0, 500) }; }
    })()
  `);

  // Check for Reddit API errors
  if (result?.json?.errors?.length) {
    const errors = result.json.errors.map((e: any) => (Array.isArray(e) ? e.join(": ") : e));
    throw new Error(`Reddit API error: ${errors.join("; ")}`);
  }

  return result;
}

// ==================== Error Wrapper ====================

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function wrapTool<T>(handler: (args: T) => Promise<ToolResult>) {
  return async (args: T): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (e: any) {
      const msg = e.message || String(e);
      console.error(`[reddit-mcp] Error: ${msg}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  };
}

// ==================== MCP Tools — Read Operations ====================

server.tool(
  "reddit_ensure_session",
  "Check if Chrome is running, Reddit tab exists, and user is logged in. Call this first.",
  {},
  wrapTool(async () => {
    const data = await redditGet("/api/me.json");
    const username = data.data?.name;
    if (username) {
      return {
        content: [
          {
            type: "text",
            text: `Connected. Logged in as u/${username}. Reddit API ready.`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: "Reddit tab found but not logged in. Please log in to Reddit in Chrome first.",
        },
      ],
    };
  })
);

server.tool(
  "reddit_me",
  "Get current logged-in Reddit user info (karma, username, account age, etc.)",
  {},
  wrapTool(async () => {
    const data = await redditGet("/api/me.json");
    return {
      content: [
        { type: "text", text: JSON.stringify(data.data || data, null, 2) },
      ],
    };
  })
);

server.tool(
  "reddit_get_post",
  "Get a Reddit post and its comments by URL or post ID",
  {
    url: z
      .string()
      .describe("Reddit post URL or post ID (e.g. '1sdv3lo')"),
    sort: z
      .enum(["top", "new", "best", "controversial", "old", "qa"])
      .default("top")
      .describe("Comment sort order"),
    limit: z.number().default(100).describe("Max comments to return"),
  },
  wrapTool(async ({ url, sort, limit }) => {
    const match = url.match(/comments\/([a-z0-9]+)/);
    const postId = match ? match[1] : url;

    const data = await redditGet(`/comments/${postId}.json`, {
      sort,
      limit: String(limit),
    });

    if (Array.isArray(data) && data.length >= 2) {
      const post = data[0]?.data?.children?.[0]?.data;
      const comments =
        data[1]?.data?.children?.map((c: any) => c.data) || [];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ post, comments }, null, 2),
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  })
);

server.tool(
  "reddit_get_comments",
  "Get all comments for a post as a flat list with author, body, score, and parent info",
  {
    url: z.string().describe("Reddit post URL or post ID"),
    sort: z
      .enum(["top", "new", "best", "controversial", "old", "qa"])
      .default("top"),
  },
  wrapTool(async ({ url, sort }) => {
    const match = url.match(/comments\/([a-z0-9]+)/);
    const postId = match ? match[1] : url;

    const data = await redditGet(`/comments/${postId}.json`, {
      sort,
      limit: "500",
    });

    if (!Array.isArray(data) || data.length < 2) {
      return {
        content: [{ type: "text", text: "Could not fetch comments" }],
      };
    }

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

    return {
      content: [{ type: "text", text: JSON.stringify(flat, null, 2) }],
    };
  })
);

server.tool(
  "reddit_get_user",
  "Get a Reddit user's profile, posts, or comments",
  {
    username: z.string().describe("Reddit username"),
    type: z
      .enum(["about", "overview", "submitted", "comments"])
      .default("about"),
    limit: z.number().default(25),
  },
  wrapTool(async ({ username, type, limit }) => {
    const path =
      type === "about"
        ? `/user/${username}/about.json`
        : `/user/${username}/${type}.json`;
    const data = await redditGet(path, { limit: String(limit) });
    return {
      content: [
        { type: "text", text: JSON.stringify(data.data || data, null, 2) },
      ],
    };
  })
);

server.tool(
  "reddit_get_subreddit",
  "Get subreddit info, rules, or browse posts (hot/new/top/rising)",
  {
    subreddit: z.string().describe("Subreddit name (without r/)"),
    type: z
      .enum(["about", "rules", "hot", "new", "top", "rising"])
      .default("hot"),
    limit: z.number().default(25),
    time: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("day")
      .describe("Time filter for top/controversial"),
  },
  wrapTool(async ({ subreddit, type, limit, time }) => {
    const path = ["about", "rules"].includes(type)
      ? `/r/${subreddit}/about/${type === "about" ? "" : "rules"}.json`
      : `/r/${subreddit}/${type}.json`;
    const data = await redditGet(path, { limit: String(limit), t: time });
    return {
      content: [
        { type: "text", text: JSON.stringify(data.data || data, null, 2) },
      ],
    };
  })
);

server.tool(
  "reddit_search",
  "Search Reddit posts globally or within a specific subreddit",
  {
    query: z.string().describe("Search query"),
    subreddit: z
      .string()
      .optional()
      .describe("Limit search to this subreddit (optional)"),
    sort: z
      .enum(["relevance", "hot", "top", "new", "comments"])
      .default("relevance"),
    time: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("all"),
    limit: z.number().default(25),
  },
  wrapTool(async ({ query, subreddit, sort, time, limit }) => {
    const path = subreddit ? `/r/${subreddit}/search.json` : `/search.json`;
    const params: Record<string, string> = {
      q: query,
      sort,
      t: time,
      limit: String(limit),
    };
    if (subreddit) params.restrict_sr = "on";
    const data = await redditGet(path, params);
    return {
      content: [
        { type: "text", text: JSON.stringify(data.data || data, null, 2) },
      ],
    };
  })
);

server.tool(
  "reddit_get_inbox",
  "Get Reddit messages (inbox, unread, or sent)",
  {
    type: z.enum(["inbox", "unread", "sent"]).default("unread"),
    limit: z.number().default(25),
  },
  wrapTool(async ({ type, limit }) => {
    const data = await redditGet(`/message/${type}.json`, {
      limit: String(limit),
    });
    return {
      content: [
        { type: "text", text: JSON.stringify(data.data || data, null, 2) },
      ],
    };
  })
);

server.tool(
  "reddit_get_subscriptions",
  "Get your subscribed subreddits",
  {
    limit: z.number().default(100).describe("Max subreddits to return"),
  },
  wrapTool(async ({ limit }) => {
    const data = await redditGet("/subreddits/mine/subscriber.json", {
      limit: String(limit),
    });
    const subs =
      data.data?.children?.map((c: any) => ({
        name: c.data.display_name,
        title: c.data.title,
        subscribers: c.data.subscribers,
        url: c.data.url,
      })) || [];
    return {
      content: [{ type: "text", text: JSON.stringify(subs, null, 2) }],
    };
  })
);

// ==================== MCP Tools — Write Operations ====================

server.tool(
  "reddit_comment",
  "Reply to a Reddit post or comment. thing_id must start with t1_ (comment) or t3_ (post).",
  {
    thing_id: z
      .string()
      .describe("Fullname of parent (t1_ for comment, t3_ for post)"),
    text: z.string().describe("Comment text (markdown supported)"),
  },
  wrapTool(async ({ thing_id, text }) => {
    const result = await redditPost("/api/comment", { thing_id, text });
    const commentData = result.json?.data?.things?.[0]?.data;
    const commentId = commentData?.id || commentData?.name;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            comment_id: commentId,
          }),
        },
      ],
    };
  })
);

server.tool(
  "reddit_submit",
  "Create a new Reddit post (text or link)",
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
  wrapTool(
    async ({
      subreddit,
      title,
      kind,
      text,
      url,
      flair_id,
      flair_text,
      nsfw,
      spoiler,
    }) => {
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.json || result, null, 2),
          },
        ],
      };
    }
  )
);

server.tool(
  "reddit_vote",
  "Upvote, downvote, or unvote on a post or comment",
  {
    thing_id: z.string().describe("Fullname (t1_ or t3_)"),
    direction: z.enum(["up", "down", "unvote"]).describe("Vote direction"),
  },
  wrapTool(async ({ thing_id, direction }) => {
    const dir =
      direction === "up" ? "1" : direction === "down" ? "-1" : "0";
    await redditPost("/api/vote", { id: thing_id, dir });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, thing_id, direction }),
        },
      ],
    };
  })
);

server.tool(
  "reddit_save",
  "Save or unsave a Reddit post or comment",
  {
    thing_id: z.string().describe("Fullname (t1_ or t3_)"),
    unsave: z.boolean().default(false).describe("Set true to unsave"),
  },
  wrapTool(async ({ thing_id, unsave }) => {
    const path = unsave ? "/api/unsave" : "/api/save";
    await redditPost(path, { id: thing_id });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            action: unsave ? "unsaved" : "saved",
            thing_id,
          }),
        },
      ],
    };
  })
);

server.tool(
  "reddit_send_message",
  "Send a Reddit private message to a user",
  {
    to: z.string().describe("Username to send to"),
    subject: z.string().describe("Message subject"),
    text: z.string().describe("Message body"),
  },
  wrapTool(async ({ to, subject, text }) => {
    await redditPost("/api/compose", { to, subject, text });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, to, subject }),
        },
      ],
    };
  })
);

server.tool(
  "reddit_edit",
  "Edit your own post or comment",
  {
    thing_id: z
      .string()
      .describe("Fullname of your post/comment to edit"),
    text: z.string().describe("New text content"),
  },
  wrapTool(async ({ thing_id, text }) => {
    await redditPost("/api/editusertext", { thing_id, text });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, edited: thing_id }),
        },
      ],
    };
  })
);

server.tool(
  "reddit_delete",
  "Delete your own post or comment",
  {
    thing_id: z
      .string()
      .describe("Fullname of your post/comment to delete"),
  },
  wrapTool(async ({ thing_id }) => {
    await redditPost("/api/del", { id: thing_id });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, deleted: thing_id }),
        },
      ],
    };
  })
);

server.tool(
  "reddit_subscribe",
  "Subscribe or unsubscribe to a subreddit",
  {
    subreddit: z.string().describe("Subreddit name (without r/)"),
    unsubscribe: z.boolean().default(false),
  },
  wrapTool(async ({ subreddit, unsubscribe }) => {
    const action = unsubscribe ? "unsub" : "sub";
    await redditPost("/api/subscribe", { action, sr_name: subreddit });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, action, subreddit }),
        },
      ],
    };
  })
);

// ==================== Start Server ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("reddit-unofficial-api MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
