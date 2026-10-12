// Sanitization tests — must produce identical output to Python _Sanitizer.clean
// per docs/SANITIZATION.md §6. Cases ported from test_server.py.
import { describe, expect, it } from "vitest";
import { sanitizeText } from "../src/sanitize.js";

describe("sanitizeText", () => {
  // 1. ANSI escape stripping (test_server.py: "line1\x1b[31mred\x1b[0m hidden \x0btabbed  next")
  it("strips ANSI + control characters", () => {
    expect(sanitizeText("line1\x1b[31mred\x1b[0mhidden \x0btabbed next")).toBe(
      "line1redhidden tabbed next"
    );
  });

  // 2. Zero-width chars stripped
  it("strips zero-width characters", () => {
    expect(sanitizeText("vis\u200bible\u202e text\ufeff")).toBe("visible text");
  });

  // 3. Raw control codes stripped
  it("strips raw control codes", () => {
    expect(sanitizeText("a\x00\x07\x1fb")).toBe("ab");
  });

  // 4. Markdown escaping (test_server.py: "[click](http://evil) `code` **bold**")
  it("escapes markdown triggers", () => {
    expect(sanitizeText("[click](http://evil) `code` **bold**")).toBe(
      "\\[click\\](http://evil) \\`code\\` \\*\\*bold\\*\\*"
    );
  });

  // 5. Whitespace collapse
  it("collapses whitespace", () => {
    expect(sanitizeText("  multiple   spaces\tand\nnewlines  ")).toBe(
      "multiple spaces and newlines"
    );
  });

  // 6. Truncation with ellipsis (test_server.py: "x" * 600, max_chars=500)
  it("truncates to maxChars with U+2026 ellipsis", () => {
    const truncated = sanitizeText("x".repeat(600), 500);
    expect(truncated.length).toBe(500);
    expect(truncated.endsWith("\u2026")).toBe(true);
    expect(truncated.slice(0, 499)).toBe("x".repeat(499));
  });

  // 7. Truncation respects rstrip before ellipsis
  it("rstrips before appending the ellipsis", () => {
    const truncated2 = sanitizeText("word ".repeat(200), 500);
    expect(truncated2.endsWith("\u2026")).toBe(true);
  });

  // 8. Empty/null/undefined
  it("returns empty string for empty, null and undefined input", () => {
    expect(sanitizeText("")).toBe("");
    expect(sanitizeText(null)).toBe("");
    expect(sanitizeText(undefined)).toBe("");
  });

  // 9. Composed attack: control chars + zero-width + markdown + length
  it("defends a composed attack (control + zero-width + markdown + length)", () => {
    const attack =
      "\x1b[2J\x1b[H\u200b**bold**\x00 `injected` \u202e" + "A".repeat(600);
    const defended = sanitizeText(attack, 500);
    expect(defended.includes("\x1b")).toBe(false);
    expect(defended.includes("\u200b")).toBe(false);
    expect(defended.includes("\x00")).toBe(false);
    expect(defended.includes("\u202e")).toBe(false);
    expect(defended.includes("\\*\\*bold\\*\\*")).toBe(true);
    expect(defended.length <= 500).toBe(true);
  });

  // 10. maxChars=1 or 0 disables truncation edge (per Python: max_chars > 1)
  it("skips truncation when maxChars <= 1", () => {
    expect(sanitizeText("x".repeat(10), 1)).toBe("x".repeat(10));
  });
});
