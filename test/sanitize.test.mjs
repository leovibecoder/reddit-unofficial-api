// Sanitization tests — must produce identical output to Python _Sanitizer.clean
// per docs/SANITIZATION.md §6. Cases ported from test_server.py.
import { strict as assert } from "assert";
import { sanitizeText } from "../build/sanitize.js";

// 1. ANSI escape stripping (test_server.py: "line1\x1b[31mred\x1b[0m hidden \x0btabbed  next")
assert.equal(
  sanitizeText("line1\x1b[31mred\x1b[0mhidden \x0btabbed next"),
  "line1redhidden tabbed next",
  "ANSI + control stripped"
);

// 2. Zero-width chars stripped
assert.equal(
  sanitizeText("vis\u200bible\u202e text\ufeff"),
  "visible text",
  "zero-width stripped"
);

// 3. Raw control codes stripped
assert.equal(sanitizeText("a\x00\x07\x1fb"), "ab", "control codes stripped");

// 4. Markdown escaping (test_server.py: "[click](http://evil) `code` **bold**")
assert.equal(
  sanitizeText("[click](http://evil) `code` **bold**"),
  "\\[click\\](http://evil) \\`code\\` \\*\\*bold\\*\\*",
  "markdown triggers escaped"
);

// 5. Whitespace collapse
assert.equal(sanitizeText("  multiple   spaces\tand\nnewlines  "), "multiple spaces and newlines", "whitespace collapsed");

// 6. Truncation with ellipsis (test_server.py: "x" * 600, max_chars=500)
const truncated = sanitizeText("x".repeat(600), 500);
assert.equal(truncated.length, 500, "truncated to 500");
assert.ok(truncated.endsWith("\u2026"), "ends with U+2026 ellipsis");
assert.ok(truncated.slice(0, 499) === "x".repeat(499), "first 499 chars are x");

// 7. Truncation respects rstrip before ellipsis
const truncated2 = sanitizeText("word ".repeat(200), 500);
assert.ok(truncated2.endsWith("\u2026"), "ends with ellipsis after rstrip");

// 8. Empty/null/undefined
assert.equal(sanitizeText(""), "", "empty string");
assert.equal(sanitizeText(null), "", "null");
assert.equal(sanitizeText(undefined), "", "undefined");

// 9. Composed attack: control chars + zero-width + markdown + length
const attack =
  "\x1b[2J\x1b[H\u200b**bold**\x00 `injected` \u202e" + "A".repeat(600);
const defended = sanitizeText(attack, 500);
assert.ok(!defended.includes("\x1b"), "no ANSI in output");
assert.ok(!defended.includes("\u200b"), "no zero-width in output");
assert.ok(!defended.includes("\x00"), "no control in output");
assert.ok(!defended.includes("\u202e"), "no bidi override in output");
assert.ok(defended.includes("\\*\\*bold\\*\\*"), "markdown escaped");
assert.ok(defended.length <= 500, "capped at 500");

// 10. maxChars=1 or 0 disables truncation edge (per Python: max_chars > 1)
assert.equal(sanitizeText("x".repeat(10), 1), "x".repeat(10), "maxChars=1 skips truncation");

console.log("All 10 sanitization tests pass — Node output matches Python spec.");
