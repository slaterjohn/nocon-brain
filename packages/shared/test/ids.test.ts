import { describe, expect, it } from "vitest";
import { createUlidFactory, idTimestamp, isPublicId, newId, ULID_PATTERN, ulid } from "../src/index.js";

describe("ids", () => {
  it("makes prefixed ids of prefix_ plus 26 Crockford characters", () => {
    const id = newId("pg");
    expect(id).toMatch(/^pg_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isPublicId(id)).toBe(true);
    expect(isPublicId(id, "pg")).toBe(true);
    expect(isPublicId(id, "src")).toBe(false);
    expect(isPublicId("pg_short")).toBe(false);
    expect(isPublicId(42)).toBe(false);
  });

  it("encodes the timestamp", () => {
    const gen = createUlidFactory({ now: () => 1_700_000_000_123 });
    expect(idTimestamp(newId("src", gen))).toBe(1_700_000_000_123);
  });

  it("sorts by creation time across milliseconds", () => {
    let t = 1_700_000_000_000;
    const gen = createUlidFactory({ now: () => t });
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(gen());
      t += 1;
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it("is strictly monotonic within one millisecond", () => {
    const gen = createUlidFactory({ now: () => 5, randomBytes: () => new Uint8Array(10).fill(255) });
    const ids = Array.from({ length: 1000 }, () => gen());
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
    ids.forEach((id) => expect(id).toMatch(ULID_PATTERN));
  });

  it("stays monotonic when the clock steps backwards", () => {
    let t = 2000;
    const gen = createUlidFactory({ now: () => t });
    const a = gen();
    t = 1000;
    const b = gen();
    expect(b > a).toBe(true);
  });

  it("default generator yields unique sortable ids", () => {
    const ids = Array.from({ length: 500 }, () => ulid());
    expect([...ids].sort()).toEqual(ids);
  });
});
