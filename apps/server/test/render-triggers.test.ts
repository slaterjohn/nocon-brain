import { describe, expect, it } from "vitest";
import { decideRender, hostIsNever, type TriggerInput } from "../src/renderer/triggers.js";

const SHELL = `<!doctype html><html><head><title>App</title><script src="/static/js/main.abc.js"></script></head><body><div id="root"></div></body></html>`;
const ARTICLE = `<!doctype html><html><head><title>A</title><script src="/a.js"></script></head><body><article>${"<p>Real server-rendered text about tides.</p>".repeat(40)}</article></body></html>`;

const base: TriggerInput = {
  html: ARTICLE, extractedChars: 1600, extractionMethod: "readability", httpStatus: 200, mime: "text/html; charset=utf-8", renderMode: "auto", host: "example.org",
};
const run = (o: Partial<TriggerInput>) => decideRender({ ...base, ...o });

describe("C-16 render triggers", () => {
  it("does not render a page that has its text", () => {
    expect(run({})).toEqual({ render: false, reasons: [], skipped: "text_found" });
  });

  it("empty mount node with little text", () => {
    for (const html of [
      SHELL,
      `<body><div id="app"></div><script src=x.js></script>`,
      `<body><div id="__next">\n  <!-- ssr failed -->\n</div>`,
      `<body><main id='root' class="x"> </main>`,
      `<body><app-root></app-root><script src="main.js"></script>`,
      `<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="x"></div>`,
    ]) {
      const d = run({ html, extractedChars: 12, extractionMethod: "readability" });
      expect(d.reasons, html).toContain("empty_mount");
      expect(d.render).toBe(true);
    }
  });

  it("an empty mount node on a page that has plenty of text does not count", () => {
    expect(run({ html: SHELL, extractedChars: 900 }).render).toBe(false);
    expect(run({ html: `<div id="root"><p>Hello</p></div>`, extractedChars: 20, extractionMethod: "readability" }).reasons).not.toContain("empty_mount");
  });

  it("very little extracted text from a large page with external scripts", () => {
    const big = `<html><head><script src="/b.js"></script></head><body><div class="x"></div><!--${"x".repeat(25_000)}--></body></html>`;
    expect(run({ html: big, extractedChars: 40 })).toEqual({ render: true, reasons: ["little_text"] });
    // small page, or no external script, or enough text: no
    expect(run({ html: `<html><script src=a.js></script><p>tiny</p>`, extractedChars: 4 }).reasons).not.toContain("little_text");
    expect(run({ html: big.replace('src="/b.js"', ""), extractedChars: 40 }).reasons).not.toContain("little_text");
    expect(run({ html: big, extractedChars: 250 }).reasons).not.toContain("little_text");
  });

  it("Readability and the second opinion both failed and the page is thin", () => {
    const d = run({ html: `<html><script src=a.js></script><body><p>${"word ".repeat(100)}</p></body>`, extractedChars: 499, extractionMethod: "body_text" });
    expect(d).toEqual({ render: true, reasons: ["no_article"] });
    expect(run({ extractedChars: 499, extractionMethod: "none", html: `<script src=a.js></script><p>hi</p>` }).reasons).toContain("no_article");
    // a long body-text fallback is a plain page, not a failure of scripts
    expect(run({ html: `<script src=a.js></script>`, extractedChars: 5000, extractionMethod: "body_text" }).render).toBe(false);
    // a failed extraction of a page with no scripts at all cannot be fixed by running scripts
    expect(run({ html: `<p>hi</p>`, extractedChars: 2, extractionMethod: "none" }).render).toBe(false);
  });

  it("can combine reasons", () => {
    const big = `<html><head><script src="/b.js"></script></head><body><div id="root"></div><!--${"x".repeat(25_000)}--></body></html>`;
    expect(run({ html: big, extractedChars: 0, extractionMethod: "none" }).reasons).toEqual(["little_text", "empty_mount", "no_article"]);
  });

  it("the source option decides first: always renders any HTML page, never does not render", () => {
    expect(run({ renderMode: "always" })).toEqual({ render: true, reasons: ["source_always"] });
    expect(run({ renderMode: "never", html: SHELL, extractedChars: 0 })).toEqual({ render: false, reasons: [], skipped: "source_never" });
  });

  it("never renders non-HTML, error statuses, hosts on the never list, or a page that was already rendered", () => {
    const shell = { html: SHELL, extractedChars: 0 };
    expect(run({ ...shell, mime: "application/pdf" }).skipped).toBe("not_html");
    expect(run({ ...shell, mime: null }).skipped).toBe("not_html");
    expect(run({ ...shell, httpStatus: 404 }).skipped).toBe("bad_status");
    expect(run({ ...shell, httpStatus: null }).skipped).toBe("bad_status");
    expect(run({ ...shell, host: "docs.example.org", neverHosts: ["*.example.org"] }).skipped).toBe("host_never");
    expect(run({ ...shell, rendered: true }).skipped).toBe("already_rendered");
    expect(run({ ...shell, renderMode: "always", mime: "image/png" }).skipped).toBe("not_html");
    expect(run({ ...shell, renderMode: "always", httpStatus: 500 }).skipped).toBe("bad_status");
    expect(run({ ...shell, renderMode: "always", rendered: true }).skipped).toBe("already_rendered");
  });

  it("is deterministic", () => {
    const a = run({ html: SHELL, extractedChars: 3 });
    for (let i = 0; i < 5; i++) expect(run({ html: SHELL, extractedChars: 3 })).toEqual(a);
  });

  it("matches the never-render list by exact host or suffix", () => {
    expect(hostIsNever("a.example.org", ["*.example.org"])).toBe(true);
    expect(hostIsNever("example.org", ["*.example.org"])).toBe(false);
    expect(hostIsNever("EXAMPLE.org.", ["example.org"])).toBe(true);
    expect(hostIsNever("x.org", ["", "  "])).toBe(false);
    expect(hostIsNever("x.org")).toBe(false);
  });
});
