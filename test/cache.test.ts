// TTL cache tests — pure logic, no network, no bridge.
import { describe, expect, it } from "vitest";
import { TTLCache } from "../src/cache.js";

describe("TTLCache", () => {
  // 1. set/get round-trip
  it("round-trips a set value", () => {
    const c1 = new TTLCache();
    c1.set("/r/opencode/hot.json", { limit: "25" }, { data: "x" }, 60);
    expect(c1.get("/r/opencode/hot.json", { limit: "25" })).toEqual({ data: "x" });
  });

  // 2. param order does not matter
  it("ignores param order in the cache key", () => {
    const c1 = new TTLCache();
    c1.set("/p.json", { b: "2", a: "1" }, "ordered", 60);
    expect(c1.get("/p.json", { a: "1", b: "2" })).toBe("ordered");
  });

  // 3. different params = different keys
  it("misses when params differ", () => {
    const c1 = new TTLCache();
    c1.set("/r/opencode/hot.json", { limit: "25" }, { data: "x" }, 60);
    expect(c1.get("/r/opencode/hot.json", { limit: "50" })).toBeUndefined();
  });

  // 4. TTL expiry
  it("evicts an entry after its TTL expires", async () => {
    const c2 = new TTLCache();
    c2.set("/x.json", {}, "short", 0.02); // 20ms
    expect(c2.get("/x.json", {})).toBe("short");
    await new Promise((r) => setTimeout(r, 40));
    expect(c2.get("/x.json", {})).toBeUndefined();
  });

  // 5. ttl=0 never stores
  it("never stores when ttl=0", () => {
    const c3 = new TTLCache();
    c3.set("/x.json", {}, "never", 0);
    expect(c3.get("/x.json", {})).toBeUndefined();
  });

  // 6. clear wipes everything
  it("clears all entries", () => {
    const c4 = new TTLCache();
    c4.set("/a.json", {}, 1, 60);
    c4.set("/b.json", {}, 2, 60);
    expect(c4.size()).toBe(2);
    c4.clear();
    expect(c4.size()).toBe(0);
    expect(c4.get("/a.json", {})).toBeUndefined();
  });
});
