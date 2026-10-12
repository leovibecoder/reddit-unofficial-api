// Sanitization unit tests — edge behaviors ONLY.
//
// Byte-parity with Python _Sanitizer.clean on the shared case set is the
// fixture's job: test/sanitize.parity.test.ts reads
// test/fixtures/sanitize_cases.json, which also drives the Python suite
// (ticket 06). Do not hand-copy fixture cases here — duplicated values
// drift. Keep this file for behaviors the fixture does not express:
// undefined input, the maxChars <= 1 guard, composed multi-stage attacks.
import { describe, expect, it } from "vitest";
import { sanitizeText } from "../src/sanitize.js";

describe("sanitizeText", () => {
  // Undefined input is TypeScript-only (the fixture's null covers Python's None).
  it("returns empty string for undefined input", () => {
    expect(sanitizeText(undefined)).toBe("");
  });

  // Composed attack: control chars + zero-width + markdown + length in one input.
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

  // maxChars=1 disables truncation edge (per the shared max_chars > 1 guard;
  // maxChars=0 lives in the fixture: truncation_zero_max_chars_disables_truncation).
  it("skips truncation when maxChars <= 1", () => {
    expect(sanitizeText("x".repeat(10), 1)).toBe("x".repeat(10));
  });
});
