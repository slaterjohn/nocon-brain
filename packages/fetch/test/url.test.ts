import { describe, expect, it } from "vitest";
import { InvalidUrlError, normaliseUrl, tryNormaliseUrl, urlKey, type NormaliseOptions } from "../src";

const ST: NormaliseOptions = { queryPolicy: "strip_tracking" };

describe("urlKey table", () => {
  const cases: [string, string, string, NormaliseOptions?][] = [
    ["tracking utm_*", "https://a.com/p?utm_source=x&utm_medium=y&id=1", "https://a.com/p?id=1", ST],
    ["UTM upper case", "https://a.com/p?UTM_Source=x&id=1", "https://a.com/p?id=1", ST],
    ["fbclid", "https://a.com/p?fbclid=abc", "https://a.com/p", ST],
    ["gclid", "https://a.com/p?id=2&gclid=abc", "https://a.com/p?id=2", ST],
    ["msclkid", "https://a.com/p?msclkid=abc", "https://a.com/p", ST],
    ["mc_cid and mc_eid", "https://a.com/p?mc_cid=1&mc_eid=2&x=1", "https://a.com/p?x=1", ST],
    ["_ga", "https://a.com/p?_ga=2.1.2", "https://a.com/p", ST],
    ["PHPSESSID", "https://a.com/p?PHPSESSID=abc&q=1", "https://a.com/p?q=1", ST],
    ["sid", "https://a.com/p?sid=s1&q=1", "https://a.com/p?q=1", ST],
    ["jsessionid path param", "https://a.com/sess/page;jsessionid=J1?q=1", "https://a.com/sess/page?q=1", ST],
    ["tracking kept under keep_all", "https://a.com/p?utm_source=x&id=1", "https://a.com/p?id=1&utm_source=x"],
    ["unrelated params untouched", "https://a.com/p?ref=main&page=2", "https://a.com/p?page=2&ref=main", ST],
    ["query sorted", "https://a.com/p?b=2&a=1", "https://a.com/p?a=1&b=2"],
    ["www not merged", "https://www.a.com/p", "https://www.a.com/p"],
    ["apex stays apex", "https://a.com/p", "https://a.com/p"],
    ["fragment stripped", "https://a.com/p#section", "https://a.com/p"],
    ["text fragment stripped", "https://a.com/p#:~:text=hi", "https://a.com/p"],
    ["trailing slash preserved on paths", "https://a.com/dir/", "https://a.com/dir/"],
    ["no trailing slash preserved", "https://a.com/dir", "https://a.com/dir"],
    ["root slash equals bare origin", "https://a.com/", "https://a.com"],
    ["host lower-cased", "HTTPS://A.COM/Path", "https://a.com/Path"],
    ["path case preserved", "https://a.com/AbC", "https://a.com/AbC"],
    ["default port dropped", "https://a.com:443/p", "https://a.com/p"],
    ["http default port dropped", "http://a.com:80/p", "http://a.com/p"],
    ["non-default port kept", "http://a.com:8080/p", "http://a.com:8080/p"],
    ["http not upgraded", "http://a.com/p", "http://a.com/p"],
    ["IDN to punycode", "https://bücher.example/p", "https://xn--bcher-kva.example/p"],
    ["IDN already punycode", "https://xn--bcher-kva.example/p", "https://xn--bcher-kva.example/p"],
    ["trailing dot host", "https://a.com./p", "https://a.com/p"],
    ["double slash path collapses in key", "https://a.com/a//b", "https://a.com/a/b"],
    ["empty query dropped", "https://a.com/p?", "https://a.com/p"],
    ["credentials dropped from key", "https://u:p@a.com/p", "https://a.com/p"],
    ["dot segments resolved", "https://a.com/a/b/../c", "https://a.com/a/c"],
    ["percent-encoded unicode path", "https://a.com/café", "https://a.com/caf%C3%A9"],
    ["drop_all", "https://a.com/p?id=1&utm_source=x", "https://a.com/p", { queryPolicy: "drop_all" }],
    ["drop_all hyphen spelling", "https://a.com/p?id=1", "https://a.com/p", { queryPolicy: "drop-all" }],
    ["strip-tracking hyphen spelling", "https://a.com/p?id=1&fbclid=z", "https://a.com/p?id=1", { queryPolicy: "strip-tracking" }],
    ["allowlist keeps named only", "https://a.com/p?id=1&page=2&junk=3", "https://a.com/p?id=1&page=2", { queryPolicy: "allowlist", allowParams: ["id", "page"] }],
    ["allowlist exact match", "https://a.com/p?idx=1&id=2", "https://a.com/p?id=2", { queryPolicy: "allowlist", allowParams: ["id"] }],
    ["allowlist empty drops all", "https://a.com/p?id=1", "https://a.com/p", { queryPolicy: "allowlist" }],
    ["relative with base", "../x?utm_source=a", "https://a.com/x", { base: "https://a.com/d/e", queryPolicy: "strip_tracking" }],
  ];
  for (const [name, input, expected, opts] of cases) {
    it(name, () => expect(urlKey(input, opts)).toBe(expected));
  }
});

describe("fetch URL versus key", () => {
  it("keeps everything but the fragment in fetchUrl", () => {
    const n = normaliseUrl("https://www.A.com/dir//x/?utm_source=a&b=2&a=1#frag", ST);
    expect(n.fetchUrl).toBe("https://www.a.com/dir//x/?utm_source=a&b=2&a=1");
    expect(n.key).toBe("https://www.a.com/dir/x/?a=1&b=2");
    expect(n.host).toBe("www.a.com");
    expect(n.origin).toBe("https://www.a.com");
  });
  it("preserves a trailing slash and an empty query marker in fetchUrl", () => {
    expect(normaliseUrl("https://a.com/dir/").fetchUrl).toBe("https://a.com/dir/");
  });
  it("flags credentials", () => {
    const n = normaliseUrl("https://u:p@a.com/");
    expect(n.hasCredentials).toBe(true);
    expect(n.key).not.toContain("u:p");
  });
});

describe("invalid input", () => {
  for (const bad of ["", "not a url", "ftp://a.com/x", "file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.c", "http://"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => normaliseUrl(bad)).toThrow(InvalidUrlError);
      expect(tryNormaliseUrl(bad)).toBeNull();
    });
  }
});

describe("key stability (property style)", () => {
  const hosts = ["a.com", "www.a.com", "BÜCHER.example", "a.com:8080"];
  const paths = ["", "/", "/x", "/x/", "/a/b/../c", "/%7Efoo", "/café"];
  const queries = ["", "?b=2&a=1", "?a=1&b=2&utm_source=z", "?fbclid=1&a=1", "?sid=1"];
  const frags = ["", "#top", "#a?b"];
  for (const policy of ["keep_all", "strip_tracking", "drop_all"] as const) {
    it(`is idempotent and fragment-insensitive under ${policy}`, () => {
      for (const h of hosts) for (const p of paths) for (const q of queries) for (const f of frags) {
        const url = `https://${h}${p}${q}${f}`;
        const key = urlKey(url, { queryPolicy: policy });
        expect(urlKey(key, { queryPolicy: policy })).toBe(key);
        expect(urlKey(`https://${h}${p}${q}`, { queryPolicy: policy })).toBe(key);
        expect(key).not.toContain("#");
      }
    });
  }
  it("is insensitive to parameter order", () => {
    expect(urlKey("https://a.com/?x=1&y=2&z=3")).toBe(urlKey("https://a.com/?z=3&x=1&y=2"));
  });
  it("different policies give different keys only where params differ", () => {
    expect(urlKey("https://a.com/p?id=1", { queryPolicy: "strip_tracking" })).toBe(urlKey("https://a.com/p?id=1"));
  });
});
