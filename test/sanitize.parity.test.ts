// Parity suite: reads the shared fixture file that also drives the Python
// suite (test_server.py). docs/SANITIZATION.md §6: sanitizeText must produce
// identical output to Python _Sanitizer.clean on the same case set. Adding a
// case to test/fixtures/sanitize_cases.json exercises both implementations.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeText } from "../src/sanitize.js";

interface SanitizeCase {
  id: string;
  input: string | null;
  max_chars: number | null;
  expected: string;
}

const fixturePath = new URL("./fixtures/sanitize_cases.json", import.meta.url);
const cases: SanitizeCase[] = JSON.parse(readFileSync(fixturePath, "utf8")).cases;

describe("sanitizeText parity (shared fixtures)", () => {
  it("fixture file is present and non-empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`case ${c.id}`, () => {
      expect(sanitizeText(c.input, c.max_chars ?? 500)).toBe(c.expected);
    });
  }
});
