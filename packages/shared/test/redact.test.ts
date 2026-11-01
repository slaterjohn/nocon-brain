import { describe, expect, it } from "vitest";
import { redactObject, redactText, redactUrl } from "../src/index.js";

describe("redactUrl", () => {
  const cases: [string, string][] = [
    ["https://user:pw@example.com/x", "https://***@example.com/x"],
    ["https://example.com/?token=abc123&q=cats", "https://example.com/?token=***&q=cats"],
    ["https://example.com/?q=cats&api_key=SECRET", "https://example.com/?q=cats&api_key=***"],
    ["https://example.com/?PASSWORD=x#frag", "https://example.com/?PASSWORD=***#frag"],
    ["/a/abcDEF123_-xyz/p/pg_01ABC", "/a/***/p/pg_01ABC"],
    ["http://localhost:3002/a/tok.en.value/v/ver_1/index.html?x=1", "http://localhost:3002/a/***/v/ver_1/index.html?x=1"],
    ["https://example.com/plain?page=2", "https://example.com/plain?page=2"],
    ["", ""],
  ];
  it.each(cases)("%s", (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe("redactText and redactObject", () => {
  it("redacts URLs and bearer tokens in free text", () => {
    expect(redactText("GET https://a:b@h.test/?token=zzz failed")).toBe("GET https://***@h.test/?token=*** failed");
    expect(redactText("Authorization: Bearer abcdefgh12345")).toBe("Authorization: Bearer ***");
  });

  it("masks secret keys and nested URL strings", () => {
    const out = redactObject({ password: "x", nested: { apiKey: "k", url: "https://u:p@h.test/" }, list: ["/a/tok/x"], n: 1 });
    expect(out).toEqual({ password: "***", nested: { apiKey: "***", url: "https://***@h.test/" }, list: ["/a/***/x"], n: 1 });
  });
});
