import { describe, expect, it } from "vitest";
import { ResourceTable, rewriteCss, rewriteInlineStyle, parseReaderPrefs, readerCss, interstitialPage, partialBannerHtml, normaliseResourceUrl, parseSrcset } from "../src/index.js";

const table = new ResourceTable([
  { url: "https://s.example/css/base.css", key: "b" },
  { url: "https://s.example/img/bg.png", key: "i" },
  { url: "https://s.example/fonts/f.woff2", key: "f" },
]);
const opts = { baseUrl: "https://s.example/css/main.css", resource: table.resolver((k) => `/r/${k}`) };

describe("rewriteCss", () => {
  it("rewrites url, @import and @font-face relative to the stylesheet", () => {
    const out = rewriteCss(`@import "base.css";@import url('http://evil.example/x.css');@font-face{font-family:f;src:url(../fonts/f.woff2) format("woff2"),url(../fonts/gone.woff)}a{background:url(../img/bg.png) no-repeat}`, opts);
    expect(out).toContain("@import");
    expect(out).toContain("/r/b");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("src:url(/r/f)");
    expect(out).not.toContain("gone");
    expect(out).toContain("background:url(/r/i)no-repeat");
  });
  it("handles image-set candidates", () => {
    const out = rewriteCss(`a{background-image:image-set(url(../img/bg.png) 1x,url(../img/missing.png) 2x)}b{background-image:image-set("../img/missing.png" 1x)}`, opts);
    expect(out).toContain("image-set(url(/r/i)1x)");
    expect(out).not.toContain("missing");
  });
  it("drops expression, behaviour, binding and unresolved urls", () => {
    const out = rewriteCss(`a{width:expression(alert(1));behavior:url(x.htc);-moz-binding:url(x);color:red}b{background:url(javascript:alert(1))}c{background:url(http://evil.example/a.png)}`, opts);
    expect(out).toBe("a{color:red}b{}c{}");
  });
  it("keeps same-document url(#id) references and small data images", () => {
    expect(rewriteCss(`a{filter:url(#f);background:url(data:image/png;base64,iVBORw0KGgo=)}`, opts)).toContain("url(#f)");
  });
  it("never lets < through", () => {
    expect(rewriteCss(`a{content:"</style><script>"}`, opts)).not.toContain("<");
  });
  it("returns empty for oversize input", () => {
    expect(rewriteCss("a{}".repeat(3_000_000), opts)).toBe("");
  });
});

describe("rewriteInlineStyle", () => {
  it("rewrites declarations only", () => {
    expect(rewriteInlineStyle("background:url(../img/bg.png);color:red", opts)).toBe("background:url(/r/i);color:red");
    expect(rewriteInlineStyle("width:expression(1)", opts)).toBe("");
  });
});

describe("helpers", () => {
  it("resource table normalises fragments and case", () => {
    expect(normaliseResourceUrl("HTTPS://S.example/a#x")).toBe("https://s.example/a");
    expect(table.lookup("https://s.example/img/bg.png#frag")?.key).toBe("i");
    expect(table.lookup("ftp://s.example/img/bg.png")).toBeUndefined();
  });
  it("parses srcset with commas in urls", () => {
    expect(parseSrcset("a.png 1x, b.png 2x,c.png")).toEqual([
      { url: "a.png", descriptor: "1x" }, { url: "b.png", descriptor: "2x" }, { url: "c.png", descriptor: "" },
    ]);
  });
  it("validates reader preferences", () => {
    const p = parseReaderPrefs(new URLSearchParams("theme=dark&font=comic&size=9&width=wide"));
    expect(p).toEqual({ theme: "dark", font: "system", size: 3, width: "wide" });
    expect(readerCss(p)).toContain("--r-width:90ch");
  });
  it("interstitial disables the live action offline and escapes the url", () => {
    const html = interstitialPage({ url: 'http://x.example/"><script>', state: "unavailable", offline: true, queueHref: "/q" });
    expect(html).not.toContain("<script>");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Queue for download");
    const on = interstitialPage({ url: "https://x.example/a", state: "live-only", offline: false });
    expect(on).toContain('target="_blank" rel="noopener noreferrer"');
  });
  it("partial banner states the count", () => {
    expect(partialBannerHtml(3)).toContain("3 files were not saved");
  });
});
