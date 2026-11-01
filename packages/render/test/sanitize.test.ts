import { describe, expect, it } from "vitest";
import { parse, serialize } from "parse5";
import { ResourceTable, collectUrls, sanitizeHtml, sanitizeSvgDocument, type SanitizeOptions } from "../src/index.js";
import { corpus } from "./xss-corpus.js";
import { problemsIn } from "./vector-check.js";

const BASE = "https://site.example/dir/page.html";

describe("XSS corpus", () => {
  it("has at least 100 vectors", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(100);
    expect(new Set(corpus.map((v) => v.name)).size).toBe(corpus.length);
  });

  const table = new ResourceTable([{ url: "https://site.example/ok.png", key: "a" }, { url: "https://site.example/s.css", key: "b" }]);
  const mapped: SanitizeOptions = {
    baseUrl: BASE,
    resource: table.resolver((k) => `/a/T/v/1/r/${k}`),
    link: (u) => ({ href: `/a/T/m?u=${encodeURIComponent(u)}`, state: "live-only" }),
  };
  const modes: [string, SanitizeOptions][] = [["no callbacks", { baseUrl: BASE }], ["with archive callbacks", mapped]];

  for (const [mode, opts] of modes) {
    describe(mode, () => {
      it.each(corpus.map((v) => [v.name, v.html] as const))("%s", (_name, html) => {
        const out = sanitizeHtml(html, opts).html;
        expect(problemsIn(out)).toEqual([]);
      });
    });
  }

  it("is stable: sanitising twice equals sanitising once", () => {
    for (const v of corpus) {
      const once = sanitizeHtml(v.html, { baseUrl: BASE }).html;
      const twice = sanitizeHtml(once, { baseUrl: BASE }).html;
      const strip = (h: string) => h.replace(/ data-ncb-link="[a-z-]+"/g, "");
      expect(strip(twice), v.name).toBe(strip(once));
    }
  });

  it("is a parse5 serialise fixpoint", () => {
    for (const v of corpus) {
      const out = sanitizeHtml(v.html, { baseUrl: BASE }).html;
      expect(serialize(parse(out, { scriptingEnabled: false })), v.name).toBe(out);
    }
  });
});

describe("fuzz round trip", () => {
  // Deterministic PRNG so failures reproduce.
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pieces = ["<", ">", "<a href=", "javascript:", "\"", "'", "<svg>", "</svg>", "<math>", "<style>", "</style>", "<table>", "<form>", "<select>", "<template>", "<noscript>", "<!--", "-->", "<img src=x onerror=1>", "&lt;", "&#106;", "<p>", "</p>", "<b>", "<textarea>", "</textarea>", "<title>", "<iframe>", "x", " ", "=", "<![CDATA[", "]]>", "<script>", "</script>", "<annotation-xml>", "<mglyph>", "<foreignObject>", "<desc>", "<plaintext>"];
  it("never leaves a vector and always reaches a fixpoint over 400 random documents", () => {
    for (let i = 0; i < 400; i++) {
      let s = "";
      const n = 3 + Math.floor(rnd() * 25);
      for (let j = 0; j < n; j++) s += pieces[Math.floor(rnd() * pieces.length)];
      const once = sanitizeHtml(s, { baseUrl: BASE }).html;
      expect(problemsIn(once), s).toEqual([]);
      const strip = (h: string) => h.replace(/ data-ncb-link="[a-z-]+"/g, "");
      expect(strip(sanitizeHtml(once, { baseUrl: BASE }).html), s).toBe(strip(once));
    }
  });
});

describe("rewriting", () => {
  const table = new ResourceTable([
    { url: "https://site.example/img/a.png", key: "1" },
    { url: "https://site.example/s.css", key: "2" },
    { url: "https://cdn.example/f.woff2", key: "3" },
  ]);
  const opts: SanitizeOptions = {
    baseUrl: BASE,
    resource: table.resolver((k) => `/a/T/v/V/r/${k}`),
    link: (u) => (u.includes("cached") ? { href: "/a/T/p/pg_1", state: "cached" } : { href: `/a/T/m?u=${encodeURIComponent(u)}`, state: "live-only" }),
  };

  it("honours then removes <base> and sets link states", () => {
    const out = sanitizeHtml(`<base href="https://site.example/img/"><a href="a.png">i</a><a href="/cached">c</a><a href="#top">t</a><a href="mailto:a@b.c">m</a><a href="http://x.example/">e</a>`, opts).html;
    expect(out).not.toContain("<base");
    expect(out).toContain('href="/a/T/m?u=https%3A%2F%2Fsite.example%2Fimg%2Fa.png"');
    expect(out).toContain('<a href="/a/T/p/pg_1" data-ncb-link="cached">');
    expect(out).toContain('<a href="#top">t</a>');
    expect(out).toContain('<a data-ncb-link="unsupported">m</a>');
    expect(out).toContain('data-ncb-link="live-only"');
  });

  it("rewrites images, srcset, link tags and drops unarchived ones", () => {
    const out = sanitizeHtml(
      `<link rel=stylesheet href="/s.css"><link rel=stylesheet href="/missing.css"><img src="/img/a.png" srcset="/img/a.png 1x, /nope.png 2x"><img src="/nope.png"><video poster="/img/a.png"></video>`,
      opts,
    );
    expect(out.html).toContain('<link rel="stylesheet" href="/a/T/v/V/r/2">');
    expect(out.html).not.toContain("missing.css");
    expect(out.html).toContain('<img src="/a/T/v/V/r/1" srcset="/a/T/v/V/r/1 1x">');
    expect(out.html).toContain("data:image/gif;base64");
    expect(out.html).toContain('poster="/a/T/v/V/r/1"');
    expect(out.stats.missingResources).toBeGreaterThanOrEqual(3);
  });

  it("rewrites CSS in style elements and attributes, keeps what resolves", () => {
    const out = sanitizeHtml(
      `<style>@import url(/s.css);@font-face{font-family:f;src:url(https://cdn.example/f.woff2) format("woff2"),url(/nope.woff)}p{background:url(/img/a.png),url(/nope.png);color:red}</style><p style="background-image:url('/img/a.png');width:expression(1)">x</p>`,
      opts,
    ).html;
    expect(out).toContain("@import url(/a/T/v/V/r/2)");
    expect(out).toContain("src:url(/a/T/v/V/r/3)format(\"woff2\")");
    expect(out).not.toContain("nope");
    expect(out).toContain("background:url(/a/T/v/V/r/1)");
    expect(out).toContain('style="background-image:url(/a/T/v/V/r/1)"');
    expect(out).not.toContain("expression");
  });

  it("keeps safe small data: images and refuses svg and oversized ones", () => {
    const px = "data:image/png;base64,iVBORw0KGgo=";
    const out = sanitizeHtml(`<img src="${px}"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="${px}" >`, { baseUrl: BASE, maxDataUriBytes: 100 }).html;
    expect(out).toContain(px);
    expect(out).not.toContain("svg+xml");
  });

  it("neutralises forms", () => {
    const out = sanitizeHtml(`<form action="http://x.example/steal" method=post><input name=q value=1><input type=hidden name=t value=s><input type=password value=pw><button>go</button></form>`, opts).html;
    expect(out).toContain("<form>");
    expect(out).not.toMatch(/action|method|hidden|name="t"|pw/);
    expect(out).toContain('<button type="button">go</button>');
  });

  it("collectUrls lists links and resources for one batched lookup", () => {
    const r = collectUrls(`<a href="/x">x</a><a href="#f">f</a><img src="/i.png"><style>p{background:url(/b.png)}</style>`, BASE);
    expect(r.links).toEqual(["https://site.example/x"]);
    expect(r.resources.sort()).toEqual(["https://site.example/b.png", "https://site.example/i.png"]);
  });

  it("injects trusted head and body markup after sanitising", () => {
    const out = sanitizeHtml(`<p>x</p>`, { baseUrl: BASE, inject: { head: "<style>a{}</style>", bodyStart: '<div id="b">B</div>' } }).html;
    expect(out).toContain("<style>a{}</style></head>");
    expect(out).toContain('<body><div id="b">B</div><p>x</p>');
  });

  it("bodyOnly returns the body children", () => {
    expect(sanitizeHtml(`<title>t</title><p onclick=1>x</p>`, { baseUrl: BASE, bodyOnly: true }).html).toBe("<p>x</p>");
  });

  it("sanitises standalone svg files", () => {
    const svg = sanitizeSvgDocument(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"><script>alert(1)</script><rect width="1" height="1" fill="red"/><foreignObject><p>x</p></foreignObject></svg>`, { baseUrl: BASE });
    expect(svg).toContain('<svg viewBox="0 0 1 1"');
    expect(svg).toContain("xmlns=");
    expect(svg).not.toMatch(/script|onload|foreignObject/i);
    expect(sanitizeSvgDocument("<p>no svg</p>", { baseUrl: BASE })).toBeNull();
  });
});
