import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { syncDb } from "../../src/search/index-core.js";

// HB-25: the rebuild reads four or five rows per page through this wrapper. Preparing a statement per call held about 40 KB per page
// until the garbage collector caught up (7.5 GB at 172,000 pages), so each statement must be prepared once.
describe("syncDb", () => {
  it("prepares each statement once per connection and still returns the rows", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b');");
    let prepared = 0;
    const real = db.prepare.bind(db);
    db.prepare = ((sql: string) => { prepared++; return real(sql); }) as typeof db.prepare;
    const s = syncDb(db);
    for (let i = 0; i < 200; i++) {
      expect(s.get<{ v: string }>("SELECT v FROM t WHERE id = ?", [1])?.v).toBe("a");
      expect(s.all<{ v: string }>("SELECT v FROM t ORDER BY id").map((r) => r.v)).toEqual(["a", "b"]);
    }
    expect(prepared).toBe(2);
  });
});
