import { describe, expect, it } from "vitest";
import { FALLBACK_BY_CODE, PAGE_ERROR, fallbackForStatus, isPlain, plainMessage } from "../lib/errors";
import { FAILURE_COPY } from "../lib/library-copy";

const CODES = ["bad_request", "unauthorized", "forbidden", "csrf", "not_found", "conflict", "rate_limited", "setup_required", "offline", "blocked", "insufficient_storage", "provider_error", "not_implemented", "internal", "unavailable", "network"];

describe("error catalogue", () => {
  it("has a sentence for every API error code", () => {
    for (const c of CODES) expect(FALLBACK_BY_CODE[c], c).toBeTruthy();
  });
  it("every sentence is plain: ends in a full stop, no exclamation mark, no jargon, says what to do or where to look", () => {
    for (const [code, text] of [...Object.entries(FALLBACK_BY_CODE), ["page", PAGE_ERROR.message]] as [string, string][]) {
      expect(isPlain(text), code).toBe(true);
      expect(text, code).toMatch(/\.$/);
      expect(text, code).not.toMatch(/!|\boops\b|\b(HTTP|stack|exception|null|undefined|500|502|503)\b/i);
      expect(text.split(/\s+/).length, `${code} is short`).toBeLessThanOrEqual(30);
    }
  });
  it("every status without a code still gets a sentence", () => {
    for (const s of [0, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 507]) expect(isPlain(fallbackForStatus(s)), String(s)).toBe(true);
  });
});

describe("plainMessage", () => {
  it("keeps the server's own sentence", () => {
    expect(plainMessage(404, "not_found", "That knowledge package does not exist.")).toBe("That knowledge package does not exist.");
  });
  it.each([
    ["a bare code", "internal"],
    ["an empty message", ""],
    ["a missing message", undefined],
    ["a stack trace", "TypeError: x is not a function\n    at run (/app/index.js:1:1)"],
    ["a runtime error code", "connect ECONNREFUSED 127.0.0.1:3001"],
    ["a disk error", "ENOSPC: no space left on device, write"],
    ["a file error", "EACCES: permission denied, open '/data/x'"],
    ["a database error", "SQLITE_BUSY: database is locked"],
    ["the browser's own words", "Failed to fetch"],
    ["JSON", '{"error":"internal"}'],
    ["a status line", "HTTP 500"],
  ])("replaces %s with the catalogue", (_n, msg) => {
    const out = plainMessage(500, "internal", msg);
    expect(out).toBe(FALLBACK_BY_CODE.internal);
  });
  it("chooses by status when the code is unknown", () => {
    expect(plainMessage(507, "weird", "ENOSPC")).toBe(FALLBACK_BY_CODE.insufficient_storage);
    expect(plainMessage(404, undefined, null)).toBe(FALLBACK_BY_CODE.not_found);
  });
});

describe("download failure copy", () => {
  it("every failure has a plain message and a hint", () => {
    const entries = Object.entries(FAILURE_COPY);
    expect(entries.length).toBeGreaterThan(5);
    for (const [code, c] of entries) {
      expect(c.message, `${code} message`).toMatch(/^[A-Z][^]*\.$/);
      expect(c.hint, `${code} hint`).toMatch(/^[A-Z][^]*\.$/);
      expect(`${c.message} ${c.hint}`, code).not.toMatch(/ECONN|ENOENT|undefined|stack trace/);
      expect(`${c.message} ${c.hint}`, code).not.toMatch(/!|\boops\b/i);
    }
  });
});
