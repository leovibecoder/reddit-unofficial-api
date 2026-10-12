// TTL cache tests — pure logic, no network, no bridge.
import { strict as assert } from "assert";
import { TTLCache } from "../build/cache.js";

// 1. set/get round-trip
const c1 = new TTLCache();
c1.set("/r/opencode/hot.json", { limit: "25" }, { data: "x" }, 60);
assert.deepEqual(c1.get("/r/opencode/hot.json", { limit: "25" }), { data: "x" }, "set/get round-trip");

// 2. param order does not matter
c1.set("/p.json", { b: "2", a: "1" }, "ordered", 60);
assert.equal(c1.get("/p.json", { a: "1", b: "2" }), "ordered", "param order ignored");

// 3. different params = different keys
assert.equal(c1.get("/r/opencode/hot.json", { limit: "50" }), undefined, "different params miss");

// 4. TTL expiry
const c2 = new TTLCache();
c2.set("/x.json", {}, "short", 0.02); // 20ms
assert.equal(c2.get("/x.json", {}), "short", "present before expiry");
await new Promise((r) => setTimeout(r, 40));
assert.equal(c2.get("/x.json", {}), undefined, "expired entry evicted");

// 5. ttl=0 never stores
const c3 = new TTLCache();
c3.set("/x.json", {}, "never", 0);
assert.equal(c3.get("/x.json", {}), undefined, "ttl=0 skips store");

// 6. clear wipes everything
const c4 = new TTLCache();
c4.set("/a.json", {}, 1, 60);
c4.set("/b.json", {}, 2, 60);
assert.equal(c4.size(), 2, "two entries");
c4.clear();
assert.equal(c4.size(), 0, "cleared");
assert.equal(c4.get("/a.json", {}), undefined, "miss after clear");

console.log("All 6 cache tests pass.");
