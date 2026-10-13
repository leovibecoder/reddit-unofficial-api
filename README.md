# Reddit Unofficial API — MCP Server

Free Reddit API. No API keys, no OAuth registration, no monthly fees.

All you need is Chrome with Reddit logged in, and Chrome DevTools Protocol enabled.

## How it works

This MCP server talks to Reddit through your browser session. When you're logged into Reddit in Chrome, your browser already has all the authentication it needs. This server simply executes `fetch()` calls in your Reddit tab's context, using the same cookies your browser uses.

```
AI Assistant → this MCP server → Chrome DevTools Protocol → your Reddit tab → Reddit's internal API
```

Reddit's internal API (the same endpoints their website uses) gives you everything: read posts, write comments, vote, search, send messages, manage subscriptions. All free, all through your existing session.

## Setup

### 1. Start Chrome with DevTools Protocol enabled

Use the repo script (it verifies the port for you):

```bash
./scripts/chrome-bridge.sh
# Already have Chrome open? Close it first, or isolate the profile:
./scripts/chrome-bridge.sh --profile-dir /tmp/chrome-bridge
```

Manual equivalent:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Cheap probe before any tool call (milliseconds, saves a failed MCP round-trip):

```bash
curl -sf -m 3 http://localhost:9222/json/version
```

Then call `reddit_ensure_session` first. It returns `bridge_ready` plus per-layer state (`cdp_reachable`, `reddit_tab_found`, `logged_in`). Call other `reddit_*` tools only when `bridge_ready` is true.

Listing tools return a compact projection by default (sub, title, author, score, comments, body snippet). That cuts the payload roughly 40x versus raw Reddit JSON. Pass `compact: false` only when you need the full payload (media metadata, awards, facets).

Present reddit picks as full-permalink markdown links. Compact output always carries `link`, so URLs arrive with no extra fetch round.

Rank topical searches by relevance, not score. `sort: "top"` ranks by points and surfaces viral threads over matching ones. Prefer `sort: "relevance"` when the question is topical, `sort: "top"` when it is best-of.

### 2. Log into Reddit in Chrome

Just open reddit.com and log in normally.

### 3. Add to your MCP config

```json
{
  "mcpServers": {
    "reddit": {
      "command": "node",
      "args": ["/path/to/reddit-unofficial-api/build/index.js"],
      "env": {
        "CHROME_CDP_URL": "http://localhost:9222"
      }
    }
  }
}
```

### 4. Build

```bash
cd reddit-unofficial-api
npm install
npm run build
```

## Available Tools

### Read Operations

| Tool | What it does |
|------|-------------|
| `reddit_me` | Get current logged-in user info |
| `reddit_get_post` | Get a post and its comments |
| `reddit_get_comments` | Get all comments as a flat list |
| `reddit_get_user` | Look up any user's profile, posts, comments, or your private tabs |
| `reddit_get_subreddit` | Get subreddit info, rules, or browse posts |
| `reddit_search` | Search within a subreddit (subreddit required) |
| `reddit_get_inbox` | Read your messages, replies, and mentions |
| `reddit_get_home_feed` | Get your personalized home feed (hot/new/top/rising) |
| `reddit_get_subscriptions` | List the subreddits you subscribe to |
| `reddit_get_multis` | List your multis (custom feeds) and their member subreddits |
| `reddit_get_multi_feed` | Read posts from one of your multis by name |

### Write Operations (1.5s rate limit between calls)

| Tool | What it does |
|------|-------------|
| `reddit_comment` | Reply to any post or comment |
| `reddit_submit` | Create a new post (text or link) |
| `reddit_vote` | Upvote, downvote, or unvote |
| `reddit_save` | Save/unsave posts or comments |
| `reddit_hide` | Hide/unhide posts (reversible) |
| `reddit_send_message` | Send a private message |
| `reddit_mark_notifications_as_read` | Mark specified notifications as read |
| `reddit_edit` | Edit your own content |
| `reddit_delete` | Delete your own content |
| `reddit_subscribe` | Join or leave a subreddit |
| `reddit_multi_create` | Create a multi (custom feed) |
| `reddit_multi_update` | Add/remove subreddits in one of your multis |
| `reddit_multi_delete` | Delete one of your multis |

### Utility

| Tool | What it does |
|------|-------------|
| `reddit_ensure_session` | Verify everything is connected and you're logged in |

---

## Tool Reference — Full Details

### `reddit_ensure_session` — Required first call

Check bridge-ready: CDP answers, reddit.com tab exists, user is logged in. Probe this before any other reddit_* tool.

**Arguments:** none

**Returns:** Bridge state object with `bridge_ready`, `cdp_reachable`, `chrome_version`, `reddit_tab_found`, `logged_in`, `username`, `bridge_version`, `build_sha`, `cdp_url`.

---

### `reddit_me` — Who am I?

Get current logged-in Reddit user info (karma, gold status, preferences, feature flags).

**Arguments:** none

**Returns:** Full user profile JSON.

---

### `reddit_get_post` — Get a post and its comments

Fetch a post by URL or ID, with its comment tree.

**Arguments:**
- `url` (string, required): Reddit post URL or post ID (e.g. `1sdv3lo`)
- `sort` (enum, default `"top"`): Comment sort — `top`, `new`, `best`, `controversial`, `old`, `qa`
- `limit` (number, default `100`): Max comments to return
- `compact` (boolean, default `true`): Compact projection (sub, title, author, score, comments, body snippet). False returns raw payload.

**Returns:** Object with `post` and `comments` arrays. Compact mode includes `link` (full permalink) on every item.

---

### `reddit_get_comments` — Flat comment list

Get all comments for a post as a flat list with author, body, score, parent info, and depth.

**Arguments:**
- `url` (string, required): Reddit post URL or post ID
- `sort` (enum, default `"top"`): `top`, `new`, `best`, `controversial`, `old`, `qa`

**Returns:** Flat array of comment objects with `id`, `author`, `body`, `score`, `parent_id`, `depth`, `created_utc`.

---

### `reddit_get_user` — User profile and private tabs

Get any user's profile, posts, comments, or your own private tabs (upvoted, downvoted, saved, hidden, controversial, trophies, friends, moderator).

**Arguments:**
- `username` (string, required): Reddit username, or `"me"` for the logged-in account
- `type` (enum, default `"about"`):
  - `about` — full profile (karma, avatar, bio, etc.)
  - `overview` — mixed posts and comments
  - `submitted` — posts only
  - `comments` — comments only
  - `controversial` — your controversial posts/comments
  - `upvoted` — things you upvoted (private, requires `me`)
  - `downvoted` — things you downvoted (private, requires `me`)
  - `saved` — saved posts/comments (private, requires `me`)
  - `hidden` — hidden posts (private, requires `me`)
  - `trophies` — your trophy case (private, requires `me`)
  - `friends` — your friends list (private, requires `me`)
  - `moderator` — subreddits you moderate (private, requires `me`)
- `limit` (number, default `25`): Max items (listing types only)
- `compact` (boolean, default `true`): Compact projection. False returns raw payload.

**Notes:**
- `about` returns the full profile object (not compacted)
- `trophies`, `friends`, `moderator` have dedicated compact projections
- `upvoted`, `downvoted`, `saved`, `hidden`, `controversial` are private — only work for your own account (`me`)
- Compact output always includes `link` (full permalink)

---

### `reddit_get_subreddit` — Subreddit info and feeds

Get subreddit metadata, rules, or browse its posts.

**Arguments:**
- `subreddit` (string, required): Subreddit name without `r/`
- `type` (enum, default `"hot"`): `about`, `rules`, `hot`, `new`, `top`, `rising`
- `limit` (number, default `25`): Max posts
- `time` (enum, default `"day"`): Time filter for `top`/`controversial` — `hour`, `day`, `week`, `month`, `year`, `all`
- `compact` (boolean, default `true`): Compact projection. False returns raw payload.

**Returns:** Subreddit object (for `about`/`rules`) or listing of posts (for feed types). Compact includes `link` on every post.

---

### `reddit_search` — Search within a subreddit

Search posts within a subreddit. Global search is not supported: unscoped search returns junk (CODING_STANDARDS §8.3), and the tool requires `subreddit`.

**Arguments:**
- `query` (string, required): Search query
- `subreddit` (string, required): Subreddit to search (without `r/`)
- `sort` (enum, default `"relevance"`): `relevance`, `hot`, `top`, `new`, `comments`
- `time` (enum, default `"all"`): `hour`, `day`, `week`, `month`, `year`, `all`
- `limit` (number, default `25`): Max results
- `compact` (boolean, default `true`): Compact projection. False returns raw payload.

**Best practice:** Use `sort: "relevance"` for topical questions, `sort: "top"` for best-of.

---

### `reddit_get_inbox` — Messages, replies, mentions

Read your Reddit messages: inbox, unread, sent, comment replies, post replies, or username mentions.

**Arguments:**
- `type` (enum, default `"unread"`):
  - `inbox` — all messages
  - `unread` — unread only
  - `sent` — sent messages
  - `comments` — replies to your comments
  - `selfreply` — replies to your posts
  - `mentions` — username mentions
- `limit` (number, default `25`): Max items
- `compact` (boolean, default `true`): Compact projection. False returns raw payload.

**Compact output:** Includes `subject` field for message-type items (comments, selfreply, mentions use `title` instead).

---

### `reddit_get_home_feed` — Your personalized home feed

Get the logged-in account's home feed: posts from your subscriptions, exactly as reddit.com shows them.

**Arguments:**
- `sort` (enum, default `"hot"`): `hot`, `new`, `top`, `rising`
- `limit` (number, default `15`): Max posts (1–50)
- `time` (enum, optional, default `"day"`): Time filter — `hour`, `day`, `week`, `month`, `year`, `all`. Only used when `sort` is `top`.

**Compact output:** Standard item projection (sub, title, author, score, comments, link, body snippet).

---

### `reddit_get_subscriptions` — Your subreddits

List all subreddits the logged-in account subscribes to. Paginated with pacing (max 4 pages / 100 items, 2s between pages to avoid 429).

**Arguments:**
- `limit` (number, default `100`): Max subreddits to return (capped at 100)
- `compact` (boolean, default `true`): Compact projection. False returns the first page's raw Reddit payload.

**Compact fields per subreddit:** `kind`, `name`, `prefixed` (e.g. `r/opencode`), `title`, `subscribers`, `over18`, `link`.

---

### `reddit_get_multis` — Your custom feeds (multis)

List the logged-in account's multis (custom feeds): display name, path, visibility, member subreddits.

**Arguments:**
- `compact` (boolean, default `true`): Compact projection. False returns raw payload.

**Compact fields per multi:** `kind`, `name`, `display_name`, `path`, `link`, `visibility` (private/public), `subCount`, `subs` (array of subreddit names).

---

### `reddit_get_multi_feed` — Read posts from a multi

Read posts from one of your multis by name. Resolves the name against your multis (case-insensitive). Paginated with pacing (max 4 pages / 100 items, 2s between pages).

**Arguments:**
- `multi` (string, required): Multi name (e.g. `"favoritos"`) or full path (`/user/<name>/m/<multi>`). Resolved against `/api/multi/mine.json`.
- `limit` (number, default `25`): Max posts (capped at 100)
- `compact` (boolean, default `true`): Compact projection. False returns first page's raw Reddit payload.

**Compact output:** Standard item projection (sub, title, author, score, comments, link, body snippet).

---

### `reddit_comment` — Reply to a post or comment

**Arguments:**
- `thing_id` (string, required): Fullname of parent (`t1_` for comment, `t3_` for post)
- `text` (string, required): Comment text (markdown supported)

**Returns:** `{ success, commentId, errors }`

---

### `reddit_submit` — Create a new post

**Arguments:**
- `subreddit` (string, required): Subreddit name without `r/`
- `title` (string, required): Post title
- `kind` (enum, required): `self` (text) or `link`
- `text` (string, optional): Post body text (for self posts)
- `url` (string, optional): URL (for link posts)
- `flair_id` (string, optional): Flair template ID
- `flair_text` (string, optional): Flair text
- `nsfw` (boolean, default `false`)
- `spoiler` (boolean, default `false`)

**Returns:** Reddit submit response JSON.

---

### `reddit_vote` — Upvote, downvote, or unvote

**Arguments:**
- `thing_id` (string, required): Fullname (`t1_` or `t3_`)
- `direction` (enum, required): `up`, `down`, `unvote`

**Returns:** `{ success: true, direction }`

---

### `reddit_save` — Save or unsave

**Arguments:**
- `thing_id` (string, required): Fullname (`t1_` or `t3_`)
- `unsave` (boolean, default `false`): Set true to unsave

**Returns:** `{ success: true, action: "saved" | "unsaved" }`

---

### `reddit_send_message` — Send a private message

**Arguments:**
- `to` (string, required): Username to send to
- `subject` (string, required): Message subject
- `text` (string, required): Message body

**Returns:** Reddit compose response JSON.

---

### `reddit_mark_notifications_as_read` — Mark specified notifications as read

**Arguments:**
- `notification_ids` (string[], required): List of notification fullnames (t4_...) to mark as read

**Returns:** { success: true, count: number }

---
### `reddit_edit` — Edit your own post or comment

**Arguments:**
- `thing_id` (string, required): Fullname of your post/comment to edit
- `text` (string, required): New text content

**Returns:** Reddit edit response JSON.

---

### `reddit_delete` — Delete your own post or comment

**Arguments:**
- `thing_id` (string, required): Fullname of your post/comment to delete

**Returns:** `{ success: true, deleted: thing_id }`

---

### `reddit_subscribe` — Subscribe or unsubscribe

**Arguments:**
- `subreddit` (string, required): Subreddit name
- `unsubscribe` (boolean, default `false`): Set true to unsubscribe

**Returns:** `{ success: true, action: "sub" | "unsub", subreddit }`

---

### `reddit_hide` — Hide or unhide a post

Hidden posts disappear from your feeds. Fully reversible.

**Arguments:**
- `thing_id` (string, required): Post fullname (`t3_`)
- `unhide` (boolean, default `false`): Set true to unhide

**Returns:** `{ success: true, action: "hidden" | "unhidden", thing_id }`

---

### `reddit_multi_create` — Create a multi (custom feed)

**Arguments:**
- `name` (string, required): Multi name — lowercase letters, numbers, underscores only (no hyphens or spaces)
- `subreddits` (string[], required): Subreddit names (without `r/`)
- `description` (string, optional): Multi description
- `visibility` (enum, default `"private"`): `private`, `public`, `hidden`

**Returns:** `{ success: true, name, subCount }`

---

### `reddit_multi_update` — Update a multi

Add or remove member subreddits, or change the description.

**Arguments:**
- `multi` (string, required): Multi name (e.g. `favoritos`)
- `add_subs` (string[], optional): Subreddit names to add
- `remove_subs` (string[], optional): Subreddit names to remove
- `description` (string, optional): New description

**Returns:** `{ success: true, multi, before, after, added, removed }`

---

### `reddit_multi_delete` — Delete a multi

Cannot be undone.

**Arguments:**
- `multi` (string, required): Multi name to delete

**Returns:** `{ success: true, deleted }`

---

## Legacy write endpoints — removed, and why

Block user (`/api/block`), friend (`/api/friend`), and report (`/api/report`) are legacy endpoints that modern Reddit has silently retired:

- `/api/block` returns 404 (route removed)
- `/api/friend type=friend` and `type=enemy` return 200 with no errors — but the friends and blocked lists never change
- `/api/report` accepts a nonexistent target with 200 and no errors — same silent no-op signature

A tool that reports success while doing nothing is worse than no tool, so none of the three ship. Use the Reddit UI for blocking, following, and reporting until a working replacement endpoint appears.

---

## Compact Projection — What you get by default

All listing tools (`get_post`, `get_user`, `get_subreddit`, `search`, `get_inbox`, `get_home_feed`, `get_subscriptions`, `get_multis`, `get_multi_feed`) return a compact projection by default. This cuts the payload ~40x versus raw Reddit JSON.

**Standard item fields (posts/comments):**
- `kind` — Reddit kind (`t1`=comment, `t3`=post, `t5`=subreddit)
- `id` — Reddit base36 ID
- `link` — Full permalink (`https://www.reddit.com/...`)
- `sub` — Subreddit name
- `title` — Post title (truncated to 140 chars)
- `subject` — Message subject (for inbox items)
- `author` — Username
- `score` — Upvotes minus downvotes
- `comments` — Number of comments
- `body` — Body text (truncated to 280 chars)
- `url` — External URL if different from permalink

**Subreddit fields (get_subscriptions):**
- `kind` — `t5`
- `name` — Internal name
- `prefixed` — `r/name` format
- `title` — Subreddit title
- `subscribers` — Subscriber count
- `over18` — NSFW flag
- `link` — `https://www.reddit.com/r/name/`

**Multi fields (get_multis):**
- `kind` — `LabeledMulti`
- `name` — Internal name
- `display_name` — Human-readable name
- `path` — Full path (`/user/name/m/multi`)
- `link` — Full URL
- `visibility` — `private` or `public`
- `subCount` — Number of member subreddits
- `subs` — Array of member subreddit names

**Trophy fields (get_user type=trophies):**
- `kind` — Trophy kind
- `name` — Trophy name
- `description` — Description
- `icon` — Icon URL (70px or 40px)

**Friend fields (get_user type=friends):**
- `kind` — User kind
- `name` — Username
- `id` — User ID
- `date` — Friend since timestamp

**Moderator subreddit fields (get_user type=moderator):**
- `kind` — `t5`
- `name` — Subreddit name
- `prefixed` — `r/name`
- `subscribers` — Subscriber count
- `over18` — NSFW flag
- `link` — Full URL

---

## Rate Limits & Pacing

- **Write operations:** 1.5s minimum between calls (enforced server-side)
- **Paginated reads:** 2s between pages (enforced server-side for subscriptions, multi feeds)
- **Reddit's native limit:** ~100 req/min authenticated — the pacing avoids tripping it
- **Read operations:** No artificial delay, but don't fire parallel calls on a cold bridge

## Response Cache

Listing tools cache GET responses in memory (PRD 4 stage 1: rate-limit/cache check):

| Category | TTL | Tools |
|----------|-----|-------|
| Post | 300s | `reddit_get_post`, `reddit_get_comments` |
| Feed | 120s | `reddit_get_home_feed`, `reddit_get_user`, `reddit_get_subreddit`, `reddit_search`, `reddit_get_subscriptions`, `reddit_get_multis`, `reddit_get_multi_feed` |
| Inbox | 30s | `reddit_get_inbox` |

- Session probes (`reddit_me`, `reddit_ensure_session`) are never cached
- Any write operation (vote, comment, hide, save, subscribe, multi create/update/delete, etc.) clears the whole cache
- Error responses are never cached
- TTLs are env-overridable: `CACHE_TTL_SECONDS` (feed, 120), `CACHE_TTL_INBOX_SECONDS` (30), `CACHE_TTL_POST_SECONDS` (300)

---

## What can you do with this?

### Community Management
- **Monitor your posts**: Check for new comments needing replies, categorize them (bug report, question, feature request, positive feedback), draft replies, approve, post
- **Batch reply**: Reply to 10+ comments in one go with personalized responses, auto-verified to go to the right person
- **Update your posts**: Edit post body to add changelogs, new links, corrections

### Research & Competitive Intelligence
- **Search Reddit**: Find all posts mentioning your product, competitor, or topic across any subreddit
- **User research**: Look up anyone's post history, comment history
- **Subreddit discovery**: Find relevant subreddits for your niche, check rules before posting

### Content & Marketing
- **Cross-post to multiple subreddits**: Draft once, submit to r/LocalLLaMA, r/androiddev, r/machinelearning, etc.
- **Track engagement**: Check which of your posts/comments are getting upvoted or replied to
- **Save interesting threads**: Bookmark posts and comments for later reference

### Inbox & Messaging
- **Read DMs**: Check if anyone messaged you about your project
- **Send DMs**: Reach out to users who want to contribute or reported bugs
- **Read replies/mentions**: `comments`, `selfreply`, `mentions` types catch all engagement

### Engagement
- **Upvote helpful feedback**: Upvote users who gave useful bug reports or feature suggestions
- **Subscribe to subreddits**: Join relevant communities from your AI assistant
- **Manage multis**: List your custom feeds, read their combined posts

### Deep Research
- **Topic deep-dive**: "Research what Reddit thinks about on-device LLM apps" → searches multiple subreddits, reads top posts and comment threads, summarizes sentiment and common complaints
- **Competitor analysis**: "What are people saying about Tool A vs Tool B" → finds all relevant threads, extracts comparisons, user experiences, pros/cons
- **Market validation**: "Is there demand for X" → searches across subreddits, analyzes upvotes and engagement, identifies audience and pain points
- **Trend tracking**: "What topics are trending this week on r/LocalLLaMA" → fetches top/rising posts, identifies emerging themes

Everything runs through your existing browser session. Zero cost, no API keys, no rate limit surprises.

---

## Why not just use the official Reddit API?

Reddit killed free API access in 2023. The official API now requires app registration, OAuth flows, and has strict rate limits. If you're building something for personal use with your own account, jumping through those hoops makes no sense.

This approach uses the exact same endpoints Reddit's own website uses. Your browser is already authenticated. We just let your AI assistant use that same session.

---

## Safety Guidelines — Don't Get Your Account Banned

This tool uses your real Reddit account. Reddit can't tell the difference between you typing and this tool typing, because it's the same browser session. That's the whole point. But it also means you need to behave like a human.

**Why the risk is low:**
- Requests come from your normal browser with your normal cookies. To Reddit's servers, it looks identical to you clicking buttons manually.
- The server adds delays between write operations (1.5s minimum). You're not hammering their API.
- Content is genuine (you write and approve the replies), not auto-generated spam.

**Rules to follow:**
- **Don't batch reply too aggressively.** 10-15 replies in one session is fine. 50 replies in 10 minutes is not. Spread it out across a few hours if you have a lot to respond to.
- **Vary your reply content.** If every reply has the exact same structure, links, and call-to-action, Reddit's spam filter will notice. Make each reply address the specific person's point.
- **Mix in normal behavior.** Browse, upvote a few things, read some posts. Don't make your entire session activity look like a bot replying to everything.
- **Don't use this for spam, vote manipulation, or astroturfing.** Obviously. This is for managing your own community and doing research, not gaming Reddit.
- **Respect subreddit rules.** Some subs don't allow self-promotion. Check before cross-posting.

**What happens if Reddit flags you:**
- Most likely: temporary rate limit (can't post for a few hours)
- Less likely: shadowban (your replies only visible to you, check at r/ShadowBan)
- Very unlikely: account suspension (only for obvious spam or manipulation)

**Recovery:**
- If rate limited, just wait. It resets.
- If shadowbanned, appeal at reddit.com/appeal. Usually reversed if your content is genuine.
- Best prevention: keep it natural. If a human wouldn't post 30 comments in 5 minutes, don't do it with this tool either.

---

## Limitations

- Needs Chrome running with DevTools Protocol (port 9222)
- Needs you to be logged into Reddit in that Chrome instance
- One Reddit account at a time (whichever is logged in)
- Rate limits are undocumented but generous for normal use
- Not suitable for high-volume scraping or bot armies (and you shouldn't do that anyway)
- All text fields in compact projections pass through `sanitizeText` per `docs/SANITIZATION.md`. The pipeline strips ANSI, zero-width, and control chars, escapes markdown, and truncates with an ellipsis.

---

## Troubleshooting

**"CDP-unreachable"** — Chrome isn't running with `--remote-debugging-port=9222`. Run `scripts/chrome-bridge.sh`.

**"NO-REDDIT-TAB"** — No reddit.com tab open in the debug Chrome window. Open reddit.com.

**"NOT-LOGGED-IN"** — Reddit tab found but not logged in. Log in to Reddit in that window.

**"STALE: live sha=..."** — The MCP host process is running an old build. Restart your MCP client (new session) after `npm run build`.

**"429 Too Many Requests"** — You're hitting Reddit's rate limit. Wait a minute. The server paces paginated reads automatically. This usually means you fired too many parallel calls.

---

## License

MIT