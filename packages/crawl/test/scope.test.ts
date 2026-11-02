import { describe, expect, it } from "vitest";
import { pathMatches, Scope, type InternalRule, type QueryConfig, type ScopeConfig } from "../src/index.js";

const base: ScopeConfig = {
  internal: "registrable", allowedDomains: [], excludedDomains: [], allowedPaths: [], excludedPaths: [], maxDepth: 5, externalDepth: 0, maxQueryParams: 6,
};
const keepAll: QueryConfig = { policy: "keep_all", allowParams: [] };
const mk = (seeds: string[], cfg: Partial<ScopeConfig> = {}, q: QueryConfig = keepAll) => new Scope({ ...base, ...cfg }, q, seeds);
const root = { depth: 0, externalDepth: 0 };

describe("internal vs external by rule (seed https://www.example.com/)", () => {
  // host, then expected for [host, subdomains, registrable]
  const cases: [string, boolean, boolean, boolean][] = [
    ["https://www.example.com/a", true, true, true],
    ["https://example.com/a", false, true, true],
    ["https://blog.example.com/a", false, true, true],
    ["https://a.b.example.com/a", false, true, true],
    ["https://www.blog.example.com/a", false, true, true],
    ["https://example.org/a", false, false, false],
    ["https://example.com.evil.net/a", false, false, false],
    ["https://notexample.com/a", false, false, false],
    ["https://wwwexample.com/a", false, false, false],
    ["https://www.example.co.uk/a", false, false, false],
    ["https://example.co.uk/a", false, false, false],
    ["http://www.example.com/a", true, true, true],
    ["https://WWW.EXAMPLE.COM/a", true, true, true],
    ["https://www.example.com:8443/a", true, true, true],
    ["https://www.example.com./a", true, true, true],
    ["https://xn--example-9d0b.com/a", false, false, false],
    ["https://sub.www.example.com/a", false, true, true],
    ["https://127.0.0.1/a", false, false, false],
    ["https://example.com@evil.net/", false, false, false],
    ["https://evil.net/example.com", false, false, false],
  ];
  const rules: InternalRule[] = ["host", "subdomains", "registrable"];
  for (const [url, ...expected] of cases) {
    rules.forEach((rule, i) => {
      it(`${rule}: ${url} -> ${expected[i] ? "internal" : "external"}`, () => {
        if (url.includes("@")) {
          expect(mk(["https://www.example.com/"], { internal: rule }).evaluate(url, root)).toMatchObject({ allow: false, reason: "scope:credentials" });
          return;
        }
        const d = mk(["https://www.example.com/"], { internal: rule, externalDepth: 1 }).evaluate(url, root);
        expect(d.allow).toBe(true);
        if (d.allow) expect(d.internal).toBe(expected[i]);
      });
    });
  }
});

describe("registrable domains use the public suffix list, private suffixes included", () => {
  const cases: [string, string, boolean][] = [
    ["https://www.bbc.co.uk/", "https://news.bbc.co.uk/x", true],
    ["https://www.bbc.co.uk/", "https://www.co.uk/x", false],
    ["https://www.bbc.co.uk/", "https://itv.co.uk/x", false],
    ["https://foo.github.io/", "https://bar.github.io/x", false],
    ["https://foo.github.io/", "https://foo.github.io/x", true],
    ["https://foo.github.io/", "https://github.io/x", false],
    ["https://a.blogspot.com/", "https://b.blogspot.com/x", false],
    ["https://shop.example.com.au/", "https://www.example.com.au/x", true],
    ["https://shop.example.com.au/", "https://other.com.au/x", false],
    ["https://example.de/", "https://www.example.de/x", true],
    ["https://example.de/", "https://example.at/x", false],
    ["https://x.s3.amazonaws.com/", "https://y.s3.amazonaws.com/x", false],
    ["https://docs.example.io/", "https://api.example.io/x", true],
    ["https://my-site.pages.dev/", "https://other.pages.dev/x", false],
    ["https://tokyo.example.jp/", "https://example.jp/x", true],
  ];
  it.each(cases)("%s -> %s internal=%s", (seed, url, internal) => {
    const d = mk([seed], { externalDepth: 1 }).evaluate(url, root);
    expect(d.allow && d.internal).toBe(internal);
  });
});

describe("hosts without a registrable domain compare their port", () => {
  const cases: [string, string, boolean][] = [
    ["http://127.0.0.1:5000/", "http://127.0.0.1:5000/a", true],
    ["http://127.0.0.1:5000/", "http://127.0.0.1:5001/a", false],
    ["http://127.0.0.1:5000/", "http://127.0.0.1/a", false],
    ["http://localhost:3000/", "http://localhost:3000/a", true],
    ["http://localhost:3000/", "http://localhost:3001/a", false],
    ["http://localhost:3000/", "http://127.0.0.1:3000/a", false],
    ["http://[::1]:8080/", "http://[::1]:8080/a", true],
    ["http://[::1]:8080/", "http://[::1]:8081/a", false],
    ["http://intranet/", "http://intranet/a", true],
    ["http://intranet/", "http://intranet:8080/a", false],
    ["http://10.0.0.5/", "http://10.0.0.6/a", false],
    ["http://10.0.0.5/", "http://10.0.0.5:80/a", true],
  ];
  it.each(cases)("%s -> %s internal=%s", (seed, url, internal) => {
    const d = mk([seed], { externalDepth: 1 }).evaluate(url, root);
    expect(d.allow && d.internal).toBe(internal);
  });
  it("the host rule also compares ports for such hosts", () => {
    const s = mk(["http://127.0.0.1:5000/"], { internal: "host", externalDepth: 1 });
    expect(s.evaluate("http://127.0.0.1:5001/", root)).toMatchObject({ allow: true, internal: false });
  });
});

describe("allowed and excluded domains", () => {
  const cases: [Partial<ScopeConfig>, string, boolean | "excluded"][] = [
    [{ allowedDomains: ["cdn.other.net"] }, "https://cdn.other.net/a", true],
    [{ allowedDomains: ["other.net"] }, "https://x.other.net/a", true],
    [{ allowedDomains: ["other.net"] }, "https://other.net/a", true],
    [{ allowedDomains: ["*.other.net"] }, "https://x.other.net/a", true],
    [{ allowedDomains: ["*.other.net"] }, "https://other.net/a", false],
    [{ allowedDomains: ["other.net"] }, "https://notother.net/a", false],
    [{ allowedDomains: ["other.net"] }, "https://other.net.evil.com/a", false],
    [{ allowedDomains: ["Other.NET"] }, "https://OTHER.net/a", true],
    [{ allowedDomains: ["other.net:8080"] }, "https://other.net:8080/a", true],
    [{ allowedDomains: ["other.net:8080"] }, "https://other.net:9090/a", false],
    [{ excludedDomains: ["ads.example.com"] }, "https://ads.example.com/a", "excluded"],
    [{ excludedDomains: ["example.com"] }, "https://www.example.com/a", "excluded"],
    [{ excludedDomains: ["*.example.com"] }, "https://www.example.com/a", "excluded"],
    [{ excludedDomains: ["*.example.com"] }, "https://example.com/a", true],
    [{ excludedDomains: ["ads.example.com"] }, "https://www.example.com/a", true],
    [{ excludedDomains: ["other.net"], allowedDomains: ["other.net"] }, "https://other.net/a", "excluded"],
    [{ excludedDomains: ["other.net"], externalDepth: 1 }, "https://other.net/a", "excluded"],
    [{ excludedDomains: ["blog.example.com"] }, "https://blog.example.com/a", "excluded"],
    [{ excludedDomains: ["blog.example.com"] }, "https://x.blog.example.com/a", "excluded"],
    [{ excludedDomains: [""] }, "https://www.example.com/a", true],
  ];
  it.each(cases)("%j %s", (cfg, url, want) => {
    const d = mk(["https://www.example.com/"], cfg).evaluate(url, root);
    if (want === "excluded") expect(d).toMatchObject({ allow: false, reason: "scope:excluded_domain" });
    else if (want) expect(d).toMatchObject({ allow: true, internal: true });
    else expect(d.allow && d.internal).toBeFalsy();
  });
});

describe("pathMatches: prefix vs glob", () => {
  const cases: [string, string, boolean][] = [
    ["/docs", "/docs", true],
    ["/docs", "/docs/", true],
    ["/docs", "/docs/a/b", true],
    ["/docs", "/docsx", false],
    ["/docs", "/doc", false],
    ["/docs", "/other/docs", false],
    ["/docs/", "/docs", true],
    ["/docs/", "/docs/a", true],
    ["docs", "/docs/a", true],
    ["/", "/anything", true],
    ["/a/b", "/a/b/c", true],
    ["/a/b", "/a", false],
    ["/Docs", "/docs", false],
    ["/docs/*", "/docs/a", true],
    ["/docs/*", "/docs/a/b", false],
    ["/docs/*", "/docs", true],
    ["/docs/**", "/docs", true],
    ["/docs/**", "/docs/a/b/c", true],
    ["/docs/**", "/docsx", false],
    ["/**/archive", "/archive", true],
    ["/**/archive", "/a/b/archive", true],
    ["/**/archive", "/a/archives", false],
    ["*.pdf", "/files/x.pdf", true],
    ["*.pdf", "/x.pdf", true],
    ["*.pdf", "/x.pdf/y", false],
    ["/files/*.pdf", "/files/x.pdf", true],
    ["/files/*.pdf", "/files/a/x.pdf", false],
    ["/files/**/*.pdf", "/files/a/b/x.pdf", true],
    ["/files/**/*.pdf", "/files/x.pdf", true],
    ["/news/????", "/news/2026", true],
    ["/news/????", "/news/26", false],
    ["/news/20[12]?", "/news/2015", true],
    ["/news/20[12]?", "/news/2035", false],
    ["/news/20[!1]?", "/news/2035", true],
    ["/news/20[0-1]?", "/news/2015", true],
    ["/{blog,news}/*", "/news/x", true],
    ["/{blog,news}/*", "/blog/x", true],
    ["/{blog,news}/*", "/shop/x", false],
    ["/tag/*/page/*", "/tag/cats/page/2", true],
    ["/tag/*/page/*", "/tag/cats/dogs/page/2", false],
    ["/a.b/*", "/a.b/c", true],
    ["/a.b/*", "/aXb/c", false],
    ["/(x)/*", "/(x)/c", true],
    ["/wp-*", "/wp-admin", true],
    ["/wp-*", "/wp-admin/x", false],
    ["/wp-*/**", "/wp-admin/x/y", true],
    ["/search*", "/search", true],
    ["/search*", "/search/results", false],
    ["/a/**/c/**", "/a/c", true],
    ["/a/**/c/**", "/a/x/y/c/z", true],
    ["/a/**/c/**", "/a/x/y/d/z", false],
  ];
  it.each(cases)("pattern %s vs %s -> %s", (pattern, path, want) => {
    expect(pathMatches(pattern, path)).toBe(want);
  });
});

describe("allowed and excluded paths in scope", () => {
  const seed = ["https://www.example.com/docs/start"];
  const cases: [Partial<ScopeConfig>, string, "ok" | "scope:path_not_allowed" | "scope:excluded_path"][] = [
    [{ allowedPaths: ["/docs"] }, "https://www.example.com/docs/a", "ok"],
    [{ allowedPaths: ["/docs"] }, "https://www.example.com/blog/a", "scope:path_not_allowed"],
    [{ allowedPaths: ["/docs"] }, "https://www.example.com/docsx", "scope:path_not_allowed"],
    [{ allowedPaths: ["/docs", "/api"] }, "https://www.example.com/api/v1", "ok"],
    [{ allowedPaths: ["/docs/**"] }, "https://www.example.com/docs", "ok"],
    [{ allowedPaths: ["/docs/*"] }, "https://www.example.com/docs/a/b", "scope:path_not_allowed"],
    [{ allowedPaths: ["/docs"], excludedPaths: ["/docs/private"] }, "https://www.example.com/docs/private/x", "scope:excluded_path"],
    [{ allowedPaths: ["/docs"], excludedPaths: ["/docs/private"] }, "https://www.example.com/docs/public/x", "ok"],
    [{ allowedPaths: ["/docs"], excludedPaths: ["/docs"] }, "https://www.example.com/docs/a", "scope:excluded_path"],
    [{ excludedPaths: ["*.pdf"] }, "https://www.example.com/a/b.pdf", "scope:excluded_path"],
    [{ excludedPaths: ["*.pdf"] }, "https://www.example.com/a/b.html", "ok"],
    [{ excludedPaths: ["/search"] }, "https://www.example.com/search?q=x", "scope:excluded_path"],
    [{ excludedPaths: ["/search"] }, "https://www.example.com/searching", "ok"],
    [{ excludedPaths: ["/tmp*/**"] }, "https://www.example.com/tmp1/scratch/", "scope:excluded_path"],
    [{ excludedPaths: ["/login", "/logout"] }, "https://www.example.com/logout", "scope:excluded_path"],
    [{ excludedPaths: ["/cart/**"] }, "https://www.example.com/cart", "scope:excluded_path"],
    [{ excludedPaths: ["/private"], externalDepth: 1 }, "https://other.org/private/x", "scope:excluded_path"],
    [{ allowedPaths: ["/docs"], externalDepth: 1 }, "https://other.org/anything", "ok"],
    [{ allowedPaths: ["/docs"], allowedDomains: ["other.org"] }, "https://other.org/anything", "scope:path_not_allowed"],
    [{ allowedPaths: [] }, "https://www.example.com/anything", "ok"],
  ];
  it.each(cases)("%j %s", (cfg, url, want) => {
    const d = mk(seed, cfg).evaluate(url, root);
    if (want === "ok") expect(d.allow).toBe(true);
    else expect(d).toMatchObject({ allow: false, reason: want });
  });
});

describe("depth and external depth", () => {
  const cases: [Partial<ScopeConfig>, { depth: number; externalDepth: number }, string, string][] = [
    [{ maxDepth: 2 }, { depth: 0, externalDepth: 0 }, "https://www.example.com/a", "ok"],
    [{ maxDepth: 2 }, { depth: 1, externalDepth: 0 }, "https://www.example.com/a", "ok"],
    [{ maxDepth: 2 }, { depth: 2, externalDepth: 0 }, "https://www.example.com/a", "scope:depth"],
    [{ maxDepth: 0 }, { depth: 0, externalDepth: 0 }, "https://www.example.com/a", "scope:depth"],
    [{ maxDepth: 1 }, { depth: 0, externalDepth: 0 }, "https://other.org/a", "scope:external"],
    [{ maxDepth: 1, externalDepth: 1 }, { depth: 0, externalDepth: 0 }, "https://other.org/a", "ok"],
    [{ maxDepth: 1, externalDepth: 1 }, { depth: 1, externalDepth: 0 }, "https://other.org/a", "scope:depth"],
    [{ maxDepth: 5, externalDepth: 1 }, { depth: 1, externalDepth: 1 }, "https://third.org/a", "scope:external_depth"],
    [{ maxDepth: 5, externalDepth: 2 }, { depth: 1, externalDepth: 1 }, "https://third.org/a", "ok"],
    [{ maxDepth: 5, externalDepth: 2 }, { depth: 2, externalDepth: 2 }, "https://fourth.org/a", "scope:external_depth"],
    [{ maxDepth: 5, externalDepth: 1 }, { depth: 1, externalDepth: 1 }, "https://www.example.com/a", "scope:left_scope"],
    [{ maxDepth: 5, externalDepth: 2 }, { depth: 1, externalDepth: 1 }, "https://www.example.com/a", "scope:left_scope"],
    [{ maxDepth: 5, externalDepth: 0 }, { depth: 0, externalDepth: 0 }, "https://other.org/a", "scope:external"],
    [{ maxDepth: 3 }, { depth: 2, externalDepth: 0 }, "https://blog.example.com/a", "ok"],
    [{ maxDepth: 3 }, { depth: 3, externalDepth: 0 }, "https://blog.example.com/a", "scope:depth"],
  ];
  it.each(cases)("%j from %j to %s -> %s", (cfg, parent, url, want) => {
    const d = mk(["https://www.example.com/"], cfg).evaluate(url, parent);
    if (want === "ok") expect(d.allow).toBe(true);
    else expect(d).toMatchObject({ allow: false, reason: want });
  });

  it("returns the new depth values for the frontier row", () => {
    const s = mk(["https://www.example.com/"], { externalDepth: 1 });
    expect(s.evaluate("https://www.example.com/a", { depth: 2, externalDepth: 0 })).toMatchObject({ allow: true, depth: 3, externalDepth: 0, internal: true });
    expect(s.evaluate("https://other.org/a", { depth: 2, externalDepth: 0 })).toMatchObject({ allow: true, depth: 3, externalDepth: 1, internal: false });
  });

  it("an external page is a leaf: one hop out and no further", () => {
    const s = mk(["https://www.example.com/"], { externalDepth: 1 });
    const hop = s.evaluate("https://other.org/", root);
    expect(hop).toMatchObject({ allow: true, externalDepth: 1 });
    if (!hop.allow) return;
    const parent = { depth: hop.depth, externalDepth: hop.externalDepth };
    expect(s.evaluate("https://other.org/next", parent)).toMatchObject({ allow: false, reason: "scope:external_depth" });
    expect(s.evaluate("https://www.example.com/back", parent)).toMatchObject({ allow: false, reason: "scope:left_scope" });
  });
});

describe("query policy and URL cleaning", () => {
  const q = (policy: QueryConfig["policy"], allowParams: string[] = []): QueryConfig => ({ policy, allowParams });
  const cases: [QueryConfig, string, string, string][] = [
    [q("keep_all"), "https://www.example.com/a?b=2&a=1", "https://www.example.com/a?b=2&a=1", "https://www.example.com/a?a=1&b=2"],
    [q("keep_all"), "https://www.example.com/a?utm_source=x", "https://www.example.com/a?utm_source=x", "https://www.example.com/a?utm_source=x"],
    [q("strip_tracking"), "https://www.example.com/a?utm_source=x&id=3", "https://www.example.com/a?id=3", "https://www.example.com/a?id=3"],
    [q("strip_tracking"), "https://www.example.com/a?fbclid=1&gclid=2", "https://www.example.com/a", "https://www.example.com/a"],
    [q("strip_tracking"), "https://www.example.com/a?id=3&utm_medium=m", "https://www.example.com/a?id=3", "https://www.example.com/a?id=3"],
    [q("drop_all"), "https://www.example.com/a?id=3&x=4", "https://www.example.com/a", "https://www.example.com/a"],
    [q("allowlist", ["id"]), "https://www.example.com/a?id=3&x=4", "https://www.example.com/a?id=3", "https://www.example.com/a?id=3"],
    [q("allowlist", ["id"]), "https://www.example.com/a?x=4", "https://www.example.com/a", "https://www.example.com/a"],
    [q("allowlist", ["id", "page"]), "https://www.example.com/a?page=2&id=1&z=9", "https://www.example.com/a?page=2&id=1", "https://www.example.com/a?id=1&page=2"],
    [q("keep_all"), "https://www.example.com/a#frag", "https://www.example.com/a", "https://www.example.com/a"],
    [q("keep_all"), "https://www.example.com/a?sid=abc&x=1", "https://www.example.com/a?x=1", "https://www.example.com/a?x=1"],
    [q("keep_all"), "https://www.example.com/a?PHPSESSID=abc", "https://www.example.com/a", "https://www.example.com/a"],
    [q("keep_all"), "https://www.example.com/a;jsessionid=J1", "https://www.example.com/a", "https://www.example.com/a"],
    [q("keep_all"), "https://www.example.com/a;jsessionid=J1?x=1", "https://www.example.com/a?x=1", "https://www.example.com/a?x=1"],
    [q("drop_all"), "https://www.example.com/a;jsessionid=J1?x=1", "https://www.example.com/a", "https://www.example.com/a"],
    [q("keep_all"), "https://www.example.com/a?x=1&sessionid=zzz&y=2", "https://www.example.com/a?x=1&y=2", "https://www.example.com/a?x=1&y=2"],
  ];
  it.each(cases)("%j %s", (query, url, fetchUrl, key) => {
    const d = mk(["https://www.example.com/"], {}, query).evaluate(url, root);
    expect(d).toMatchObject({ allow: true, fetchUrl, key });
  });

  it("reports when a session id was removed", () => {
    expect(mk(["https://www.example.com/"]).evaluate("https://www.example.com/a?sid=1", root)).toMatchObject({ allow: true, sessionStripped: true });
    expect(mk(["https://www.example.com/"]).evaluate("https://www.example.com/a?id=1", root)).toMatchObject({ allow: true, sessionStripped: false });
  });

  it("two session variants of one page share a key", () => {
    const s = mk(["https://www.example.com/"]);
    const a = s.evaluate("https://www.example.com/p?sid=s1", root);
    const b = s.evaluate("https://www.example.com/p?PHPSESSID=x&sid=s2", root);
    expect(a.allow && b.allow && a.key === b.key).toBe(true);
  });

  it("the same parameters in another order share a key", () => {
    const s = mk(["https://www.example.com/"]);
    const a = s.evaluate("https://www.example.com/f?sort=p&filter=a", root);
    const b = s.evaluate("https://www.example.com/f?filter=a&sort=p", root);
    expect(a.allow && b.allow && a.key === b.key).toBe(true);
  });

  const many = (n: number) => `https://www.example.com/a?${Array.from({ length: n }, (_, i) => `p${i}=1`).join("&")}`;
  it.each([[1, true], [6, true], [7, false], [20, false]])("%i distinct query parameters allowed=%s (limit 6)", (n, ok) => {
    const d = mk(["https://www.example.com/"]).evaluate(many(n), root);
    if (ok) expect(d.allow).toBe(true);
    else expect(d).toMatchObject({ allow: false, reason: "scope:query_params" });
  });
});

describe("malformed and unsupported URLs", () => {
  const cases: [string, string][] = [
    ["mailto:a@b.com", "scope:scheme"],
    ["javascript:alert(1)", "scope:scheme"],
    ["ftp://www.example.com/a", "scope:scheme"],
    ["data:text/html,hi", "scope:scheme"],
    ["file:///etc/passwd", "scope:scheme"],
    ["tel:+4412345", "scope:scheme"],
    ["http://", "scope:invalid_url"],
    ["http://[::1", "scope:invalid_url"],
    ["https://user:pw@www.example.com/a", "scope:credentials"],
    ["https://user@www.example.com/a", "scope:credentials"],
  ];
  it.each(cases)("%s -> %s", (url, reason) => {
    expect(mk(["https://www.example.com/"]).evaluate(url, root)).toMatchObject({ allow: false, reason });
  });

  it("resolves relative links against the page", () => {
    const s = mk(["https://www.example.com/"]);
    expect(s.evaluate("../b?x=1", root, "https://www.example.com/a/c/")).toMatchObject({ allow: true, fetchUrl: "https://www.example.com/a/b?x=1" });
    expect(s.evaluate("//cdn.example.com/x", root, "https://www.example.com/")).toMatchObject({ allow: true, internal: true });
    expect(s.evaluate("/abs", root, "https://www.example.com/a/c/")).toMatchObject({ allow: true, fetchUrl: "https://www.example.com/abs" });
  });

  it("several start URLs make all their sites internal", () => {
    const s = mk(["https://www.example.com/", "https://other.org/"]);
    expect(s.evaluate("https://sub.other.org/a", root)).toMatchObject({ allow: true, internal: true });
    expect(s.evaluate("https://third.net/a", root)).toMatchObject({ allow: false, reason: "scope:external" });
  });

  it("excluded wins over allowed, over the path allow-list and over external hops", () => {
    const s = mk(["https://www.example.com/"], { allowedDomains: ["x.org"], excludedDomains: ["x.org"], externalDepth: 1 });
    expect(s.evaluate("https://x.org/a", root)).toMatchObject({ allow: false, reason: "scope:excluded_domain" });
  });
});
