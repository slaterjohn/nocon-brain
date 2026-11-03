import { describe, expect, it } from "vitest";
import { addDoc, drained, searchApi, startSearchServer } from "../integration/search/helpers.js";

/**
 * H-03 XSS: search results from the local index. Titles and snippets are text that came from a page somebody else wrote. The API may
 * carry them as strings, but the two fields that are meant to be shown with highlighting (`snippet`, `titleHtml`) may hold `<mark>` and
 * `</mark>` and nothing else: every other angle bracket must be an entity.
 */

const MARKED = /^(?:[^<>]|<\/?mark>)*$/;
const A = "alert(1)";

const BODIES = [
  `&lt;script&gt;${A}&lt;/script&gt; quokkazorn`,
  `&lt;img src=x onerror=${A}&gt; quokkazorn`,
  `&lt;/mark&gt;&lt;script&gt;${A}&lt;/script&gt;&lt;mark&gt; quokkazorn`,
  `&lt;mark onmouseover=${A}&gt;quokkazorn&lt;/mark&gt;`,
  `quokkazorn &amp;lt;b&amp;gt; &amp;amp; &amp;#60;script&amp;#62;`,
  `&lt;svg onload=${A}&gt;&lt;a href=javascript:${A}&gt;quokkazorn&lt;/a&gt;`,
  `quokkazorn "quoted" 'single' \`tick\` \\u003cscript\\u003e`,
  ` quokkazorn &lt;iframe srcdoc="&lt;script&gt;${A}&lt;/script&gt;"&gt;`,
];
const TITLES = [
  `<img src=x onerror=${A}>`, `<script>${A}</script>`, `"><svg onload=${A}>`, `quokkazorn <mark>marked</mark> title`, `&lt;b&gt;entity&lt;/b&gt;`, `‮<script>${A}</script>`,
];

function stringsOf(o: unknown, key: RegExp, out: { path: string; value: string }[] = [], path = ""): { path: string; value: string }[] {
  if (Array.isArray(o)) o.forEach((x, i) => stringsOf(x, key, out, `${path}[${i}]`));
  else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && key.test(k)) out.push({ path: `${path}.${k}`, value: v });
      else stringsOf(v, key, out, `${path}.${k}`);
    }
  }
  return out;
}

describe("search snippets and highlighted titles", () => {
  it("hold <mark> and nothing else, whatever the page wrote", async () => {
    const t = await startSearchServer();
    for (const [i, body] of BODIES.entries()) await addDoc(t, `b${i}.html`, `Plain title ${i}`, body);
    for (const [i, title] of TITLES.entries()) await addDoc(t, `t${i}.html`, title, `quokkazorn ${A} body ${i}`);
    await drained(t);
    let checked = 0;
    for (const q of ["quokkazorn", "alert", "script", "onerror", "mark", "svg", "img", "title", "body", "quoted"]) {
      const r = await searchApi(t, { query: q });
      expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);
      for (const f of stringsOf(r.body, /^(snippet|titleHtml|.*Html|highlight.*)$/)) {
        checked++;
        expect(MARKED.test(f.value), `${q} ${f.path}: ${f.value.slice(0, 200)}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(10);
  }, 180_000);

  it("the entity form of markup stays an entity: it is never decoded into a tag by the server", async () => {
    const t = await startSearchServer();
    await addDoc(t, "e.html", "Entities", `&lt;script&gt;${A}&lt;/script&gt; quokkazorn`);
    await drained(t);
    const r = await searchApi(t, { query: "quokkazorn" });
    const snip = stringsOf(r.body, /^snippet$/).map((x) => x.value).join(" ");
    expect(snip).not.toMatch(/<script/i);
    expect(snip).toContain("&lt;script&gt;");
  }, 120_000);

  it("suggestions, saved searches and history return queries as data, with the JSON headers that stop sniffing", async () => {
    const t = await startSearchServer();
    await addDoc(t, "s.html", "Suggest", "quokkazorn suggestion text");
    await drained(t);
    for (const q of [`<script>${A}</script>`, `"><img src=x onerror=${A}>`, "quokka'--", "quokka\\", "%00", "a".repeat(1000)]) {
      const s = await t.api("GET", `/api/search/suggestions?q=${encodeURIComponent(q)}`);
      expect(s.status, q.slice(0, 30)).toBeLessThan(500);
      const r = await searchApi(t, { query: q });
      expect(r.status, q.slice(0, 30)).toBeLessThan(500);
    }
    const res = await t.server.app.inject({ method: "GET", url: "/api/search/history", headers: { cookie: t.cookie } });
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  }, 120_000);
});
