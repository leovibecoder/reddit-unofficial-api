// External-URL content extraction (PRD 7.1 / ADR 0001, N-001 token reduction).
// Strategy-pattern backends; Phase 1 ships the Crawl4AI Cloud client only.
// Extractors return RAW markdown — sanitizeText in index.ts is the single
// sanitization gate before anything reaches the LLM (docs/SANITIZATION.md).

const CRAWL4AI_ENABLED = process.env.CRAWL4AI_ENABLED === "true";
const CRAWL4AI_KEY = process.env.CRAWL4AI_KEY || "";
const CRAWL4AI_TIMEOUT = Number(process.env.CRAWL4AI_TIMEOUT || "30") * 1000;
const CRAWL4AI_MIN_CHARS = Number(process.env.CRAWL4AI_MIN_CHARS || "100");
const MAX_ATTEMPTS = 3;

// Health circuit: after 3 consecutive failures the extractor self-disables
// until the next server start (ADR 0001 §5). Never blocks the read pipeline.
let consecutiveFailures = 0;
const DISABLE_THRESHOLD = 3;

export interface ExtractionResult {
  markdown: string;
  url: string;
  chars: number;
  backend: string;
  fallback_used: boolean;
}

export function extractionConfigured(): boolean {
  return CRAWL4AI_ENABLED && !!CRAWL4AI_KEY;
}

export function extractionHealthy(): boolean {
  return consecutiveFailures < DISABLE_THRESHOLD;
}

async function cloudScrape(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRAWL4AI_TIMEOUT);
  try {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch("https://api.crawl4ai.com/scrape", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CRAWL4AI_KEY}`,
          },
          body: JSON.stringify({ urls: [url], formats: ["markdown"] }),
          signal: controller.signal,
        });
        if (res.ok) {
          const body: unknown = await res.json();
          const md = extractMarkdown(body);
          if (md.length >= CRAWL4AI_MIN_CHARS) {
            return md;
          }
          throw new Error(
            `extraction below CRAWL4AI_MIN_CHARS (${md.length} < ${CRAWL4AI_MIN_CHARS})`
          );
        }
        // 429/5xx retryable; other 4xx are not.
        if (res.status !== 429 && res.status < 500) {
          throw new Error(`crawl4ai ${res.status}: not retryable`);
        }
        lastErr = new Error(`crawl4ai ${res.status}`);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("not retryable")) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastErr ?? new Error("crawl4ai: exhausted retries");
  } finally {
    clearTimeout(timer);
  }
}

function extractMarkdown(body: unknown): string {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if ("results" in obj && Array.isArray(obj.results) && obj.results[0]) {
      const r = obj.results[0] as Record<string, unknown>;
      if ("markdown" in r && typeof r.markdown === "string") return r.markdown;
    }
    if ("data" in obj && obj.data && typeof obj.data === "object") {
      const d = obj.data as Record<string, unknown>;
      if ("markdown" in d && typeof d.markdown === "string") return d.markdown;
    }
    if ("markdown" in obj && typeof obj.markdown === "string") return obj.markdown;
  }
  return "";
}

/**
 * Extract readable markdown from an external URL via Crawl4AI Cloud.
 * Returns null when disabled, unhealthy, or extraction fails — callers
 * fall back to Reddit-native content and the pipeline never breaks.
 */
export async function extractUrl(
  url: string,
  opts: { log?: (msg: string) => void } = {}
): Promise<ExtractionResult | null> {
  if (!extractionConfigured()) return null;
  if (!extractionHealthy()) return null;
  try {
    const markdown = await cloudScrape(url);
    consecutiveFailures = 0;
    opts.log?.(
      `extract: ok backend=cloud url=${url} chars=${markdown.length}`
    );
    return {
      markdown,
      url,
      chars: markdown.length,
      backend: "cloud",
      fallback_used: false,
    };
  } catch (err: unknown) {
    consecutiveFailures++;
    opts.log?.(
      `extract: fail backend=cloud url=${url} consecutive=${consecutiveFailures} err=${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}