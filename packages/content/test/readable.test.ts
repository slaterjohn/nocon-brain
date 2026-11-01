import { describe, expect, it } from "vitest";
import { buildOutline, extractReadable, guardHtml, sanitiseReaderHtml } from "../src/index.js";

const prose = (n: number) => "<p>This paragraph has enough ordinary prose to look like article text to an extractor.</p>".repeat(n);
const url = "https://example.com/post";

describe("A-08 extraction", () => {
  it("extracts an article with Readability", async () => {
    const r = await extractReadable(`<!doctype html><html><head><title>T</title></head><body><nav><a href="/">Home</a></nav><article><h1>Title</h1>${prose(12)}<h2>Part two</h2>${prose(3)}</article><footer>fine print</footer></body></html>`, { url });
    expect(r.method).toBe("readability");
    expect(r.text).toContain("ordinary prose");
    expect(r.text).not.toContain("fine print");
    expect(r.wordCount).toBeGreaterThan(100);
  });

  it("falls back to defuddle, then to body text, when Readability gives nothing", async () => {
    const tiny = "<!doctype html><title>Tiny</title><body><div>Just a handful of words in a div.</div></body>";
    const r = await extractReadable(tiny, { url });
    expect(r.method).toBe("body_text");
    expect(r.text).toContain("handful of words");
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    const onlyDefuddle = await extractReadable(`<!doctype html><title>D</title><body><main>${prose(10)}</main></body>`, { url, engines: ["defuddle"] });
    expect(onlyDefuddle.method).toBe("defuddle");
    expect(onlyDefuddle.text).toContain("ordinary prose");
  });

  it("refuses pathological documents before parsing", async () => {
    expect(guardHtml("x".repeat(6 * 1024 * 1024))).toEqual({ ok: false, reason: "too_large" });
    expect(guardHtml("<div>".repeat(2000) + "</div>".repeat(2000))).toEqual({ ok: false, reason: "too_deep" });
    expect(guardHtml("<p>a".repeat(1000))).toMatchObject({ ok: true }); // unclosed <p> is not nesting
    expect(guardHtml("<b></b>".repeat(450_000))).toEqual({ ok: false, reason: "too_many_nodes" });
    await expect(extractReadable("<div>".repeat(2000), { url })).rejects.toThrow(/too_deep/);
  });

  it("keeps outline anchors stable and identical to the reader HTML ids", () => {
    const html = `<h2>Overview</h2><p>a b c</p><h2>Overview</h2><p>d</p><h3>Détails & more</h3><p>e</p>`;
    const a = buildOutline(html, url);
    const b = buildOutline(html, url);
    expect(a).toEqual(b);
    expect(a.sections.map((s) => s.anchor)).toEqual(["overview", "overview-2", "details-more"]);
    const r = sanitiseReaderHtml(html, url);
    for (const s of a.sections) expect(r.html).toContain(`id="${s.anchor}"`);
    expect(a.sections[0]!.text).toContain("a b c");
    expect(r.text.slice(a.sections[1]!.start, a.sections[1]!.end)).toContain("d");
  });
});

describe("reader HTML allowlist", () => {
  const out = (html: string) => sanitiseReaderHtml(html, url).html;
  it("drops everything that can execute, submit, embed or restyle", () => {
    const h = out(`<p onclick="x()" style="color:red" class="a">hi<script>alert(1)</script><iframe src="//e"></iframe><form action="/x"><input></form><svg><script>1</script></svg><style>p{}</style><object data="x"></object></p>
      <a href="javascript:alert(1)">bad</a><a href="data:text/html,x">bad2</a><a href="/ok" target="_top" onmouseover="x">good</a><img src="x.png" onerror="y()" srcset="a 1x"><img src="javascript:1"><math><mi>x</mi></math>`);
    expect(h).not.toMatch(/script|onclick|onerror|onmouseover|style|class=|iframe|form|input|svg|object|math|javascript|data:|target=|srcset/i);
    expect(h).toContain('<a href="https://example.com/ok">good</a>');
    expect(h).toContain('<img src="https://example.com/x.png">');
    expect(h).toContain("bad"); // an unsafe anchor keeps its text
  });
  it("unwraps unknown elements and escapes text", () => {
    expect(out("<custom-el><b>x</b> &lt;b&gt; <font>y</font></custom-el>")).toBe("<b>x</b> &lt;b&gt; y");
  });
  it("is stable under a second pass", () => {
    const once = out(`<h2>A</h2><p>Hi <a href="/x?a=1&b=2">link</a></p><table><tr><td colspan="2">c</td></tr></table>`);
    expect(out(once)).toBe(once);
  });
});
