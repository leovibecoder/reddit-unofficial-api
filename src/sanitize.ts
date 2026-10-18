// Sanitization pipeline — mirrors server.py _Sanitizer.clean per docs/SANITIZATION.md.
// Order matters: ANSI → zero-width → control → whitespace → markdown → truncation.
// XML escaping and boundary tags are Python-server-only: the bridge outputs
// JSON, where JSON.stringify handles quoting (see SANITIZATION.md §6 note).

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ZERO_WIDTH_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MARKDOWN_CONTROL = new Set(["`", "*", "_", "~", "[", "]"]);

export function sanitizeText(
  text: string | null | undefined,
  maxChars: number = 500
): string {
  if (!text) return "";
  let t = String(text);
  t = t.replace(ANSI_RE, "");
  t = t.replace(ZERO_WIDTH_RE, "");
  t = t.replace(CONTROL_RE, "");
  t = t.replace(/\s+/g, " ").trim();
  t = [...t].map((c) => (MARKDOWN_CONTROL.has(c) ? `\\${c}` : c)).join("");
  if (maxChars > 1 && t.length > maxChars) {
    t = t.slice(0, maxChars - 1).trimEnd() + "\u2026";
  }
  return t;
}
