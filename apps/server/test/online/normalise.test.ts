import { describe, expect, it } from "vitest";
import { canonicalKey, checkResultUrl, escapeHtml, highlight, htmlToText } from "../../src/online/normalise.js";
import { brave, mojeek, searxng } from "../../src/online/adapters.js";
import type { HttpClient } from "../../src/online/types.js";

const XSS = [
  `<script>alert(1)</script>Hello`, `<img src=x onerror=alert(1)>Hello`, `Hello<svg/onload=alert(1)>`, `<a href="javascript:alert(1)">Hello</a>`,
  `&lt;script&gt;alert(1)&lt;/script&gt;Hello`, `&amp;lt;img src=x onerror=alert(1)&amp;gt;Hello`, `<<script>script>alert(1)<</script>/script>Hello`,
  `<iframe src="https://evil.example"></iframe>Hello`, `<style>body{display:none}</style>Hello`, `Hello <b onmouseover=alert(1)`, `&#60;img src=x onerror=alert(1)&#62;Hello`,
];

describe("provider text is untrusted (O-01, O-10)", () => {
  it.each(XSS)("htmlToText leaves no markup: %s", (payload) => {
    const t = htmlToText(payload);
    expect(t).not.toMatch(/<\/?[a-z!]/i);
    expect(t).toContain("Hello");
    expect(escapeHtml(t)).not.toMatch(/<(?!\/?mark)/);
  });

  it("highlight escapes everything and adds only <mark>", () => {
    const h = highlight(`<img src=x onerror=alert(1)> turbines "q" & 'a'`, ["turbines", "<img"]);
    expect(h).toContain("<mark>turbines</mark>");
    expect(h.replace(/<\/?mark>/g, "")).not.toMatch(/[<>]/);
    expect(h).toContain("&lt;");
    expect(h).toContain("&quot;");
  });

  it("clamps long text and strips control and bidi characters", () => {
    const t = htmlToText("a\u0000b‮c " + "word ".repeat(200), 100);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t.startsWith("a b c")).toBe(true);
  });

  it.each([
    "javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "ftp://example.org/x", "//example.org/x", "https://user:pw@example.org/", "https://",
    "https://exa mple.org/", "https://example.org/\u0000", "", "   ", "not a url", "https://example.org/" + "a".repeat(3000),
  ])("rejects the URL %s", (u) => {
    expect(checkResultUrl(u)).toBeNull();
  });

  it("accepts http and https, strips fragments and tracking parameters from the key", () => {
    const c = checkResultUrl("HTTPS://WWW.Example.org/a/b?utm_source=x&id=1#frag")!;
    expect(c.url).toBe("https://www.example.org/a/b?id=1");
    expect(c.key).toBe(canonicalKey("https://www.example.org/a/b?id=1"));
    expect(c.key).not.toContain("utm_source");
    expect(checkResultUrl("http://example.org/")).not.toBeNull();
  });

  it("canonicalises Wikipedia articles so ZIM and online hits merge", () => {
    const a = checkResultUrl("https://en.wikipedia.org/wiki/Tidal_power")!;
    const b = checkResultUrl("https://en.m.wikipedia.org/wiki/Tidal%5Fpower#History")!;
    const c = checkResultUrl("https://de.wikipedia.org/wiki/Tidal_power")!;
    expect(a.key).toBe("wikipedia:en:Tidal_power");
    expect(b.key).toBe(a.key);
    expect(c.key).not.toBe(a.key);
  });
});

const client = (status: number, body: string, headers: Record<string, string> = {}): HttpClient => ({ get: async () => ({ status, headers, body }) });
const q = { query: "x", signal: new AbortController().signal };

describe("adapters map answers and errors (O-02, O-03, O-04)", () => {
  it("searxng: results, partial failure, dropped URLs, JSON-disabled setup error", async () => {
    const body = JSON.stringify({
      results: [{ url: "https://a.example/1", title: "<b>One</b>", content: "<script>x</script>First", engines: ["g"] }, { url: "javascript:alert(1)", title: "bad" }, { title: "no url" }],
      unresponsive_engines: [["brave", "timeout"], ["google", "captcha"]],
    });
    const r = await searxng.search(q, { baseUrl: "http://s", apiKey: undefined }, client(200, body));
    expect(r.results.map((x) => [x.title, x.snippet, x.rank])).toEqual([["One", "First", 1]]);
    expect(r.dropped).toBe(2);
    expect(r.partial).toEqual({ failedEngines: ["brave", "google"] });
    await expect(searxng.search(q, { baseUrl: "http://s", apiKey: undefined }, client(403, "<html>"))).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("search.formats") });
    await expect(searxng.search(q, { baseUrl: "http://s", apiKey: undefined }, client(200, "<html>nope"))).rejects.toMatchObject({ code: "bad_request" });
  });

  it("brave: needs a key, sends the token header, maps 401, 429 and 5xx", async () => {
    await expect(brave.search(q, { baseUrl: null, apiKey: undefined }, client(200, "{}"))).rejects.toMatchObject({ code: "auth" });
    let seen: Record<string, string> | undefined;
    const spy: HttpClient = { get: async (_u, o) => { seen = o.headers; return { status: 200, headers: {}, body: JSON.stringify({ web: { results: [{ url: "https://b.example/", title: "B", description: "d" }] } }) }; } };
    const ok = await brave.search(q, { baseUrl: null, apiKey: "k" }, spy);
    expect(seen?.["x-subscription-token"]).toBe("k");
    expect(ok.results).toHaveLength(1);
    await expect(brave.search(q, { baseUrl: null, apiKey: "k" }, client(401, "{}"))).rejects.toMatchObject({ code: "auth", retryable: false });
    await expect(brave.search(q, { baseUrl: null, apiKey: "k" }, client(429, "{}", { "retry-after": "7" }))).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 7000, retryable: false });
    await expect(brave.search(q, { baseUrl: null, apiKey: "k" }, client(503, "{}"))).rejects.toMatchObject({ code: "upstream", retryable: true });
  });

  it("mojeek: maps results and a non-OK status", async () => {
    const ok = await mojeek.search(q, { baseUrl: null, apiKey: "k" }, client(200, JSON.stringify({ response: { status: "OK", results: [{ url: "https://m.example/", title: "M", desc: "dd" }] } })));
    expect(ok.results[0]).toMatchObject({ title: "M", snippet: "dd" });
    await expect(mojeek.search(q, { baseUrl: null, apiKey: "k" }, client(200, JSON.stringify({ response: { status: "invalid api key" } })))).rejects.toMatchObject({ code: "auth" });
    await expect(mojeek.search(q, { baseUrl: null, apiKey: "k" }, client(402, "{}"))).rejects.toMatchObject({ code: "quota_exhausted" });
  });
});
