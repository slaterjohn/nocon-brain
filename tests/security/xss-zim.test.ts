import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { corpus } from "../../packages/render/test/xss-corpus.js";
import { problemsIn } from "../../packages/render/test/vector-check.js";
import { buildHostileZim } from "../fixtures/zim/build.mjs";
import { startZimServer, type ZimTest } from "../integration/zim/helpers.js";

/**
 * H-03 XSS corpus against ZIM serving: `/a/{token}/z/{zimId}/{path}`.
 * A package built to attack the reader (tests/fixtures/zim/build.mjs `buildHostileZim`): one article per sanitiser-corpus vector, entries whose
 * declared type disagrees with their bytes, script, SVG, XHTML and UTF-7 entries, a style sheet with imports, and markup in every metadata field.
 */

const HEADERS_OK = (r: Response, label: string) => {
  const csp = r.headers.get("content-security-policy") ?? "";
  expect(csp, `${label} csp`).toMatch(/^sandbox( allow-popups allow-popups-to-escape-sandbox)?; default-src 'none'/);
  expect(csp, `${label} csp scripts`).not.toContain("allow-scripts");
  expect(csp, `${label} csp same-origin`).not.toContain("allow-same-origin");
  expect(r.headers.get("x-content-type-options"), `${label} nosniff`).toBe("nosniff");
  expect(r.headers.get("referrer-policy"), `${label} referrer`).toBe("no-referrer");
  expect(r.headers.get("set-cookie"), `${label} cookie`).toBeNull();
};

/** A request with the path exactly as written (fetch and URL would tidy `..` away before it left). */
function raw(port: number, rawPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: rawPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function hostile(t: ZimTest) {
  const lib = path.join(t.rootsDir, "library");
  fs.mkdirSync(lib, { recursive: true });
  const file = path.join(lib, "hostile.zim");
  await buildHostileZim(file, corpus.map((v) => ({ name: v.name, html: v.html })));
  const added = await t.api("POST", "/api/zim/packages/import", { path: file });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  const g = await t.api("POST", "/api/archive/frame-grants", { zimId: added.body.id, zimPath: "" });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  const base = (g.body.url as string).replace(/\/z\/.*$/, "");
  return { id: added.body.id as string, pkg: added.body, base, get: (p: string, init?: RequestInit) => t.archiveFetch(`${base}/z/${added.body.id}/${p}`, { redirect: "manual", ...init }) };
}

describe("every corpus vector, served from a package", () => {
  it("leaves no executable construct in any article, and every response carries the archive headers", async () => {
    const t = await startZimServer();
    const h = await hostile(t);
    const bad: string[] = [];
    let served = 0;
    for (const [i, v] of corpus.entries()) {
      if (v.html.length > 100_000) continue;
      const r = await h.get(`V${i}`);
      if (r.status !== 200) { bad.push(`${v.name}: status ${r.status}`); continue; }
      served++;
      HEADERS_OK(r, v.name);
      expect(r.headers.get("content-type"), v.name).toMatch(/^text\/html/);
      const body = await r.text();
      const problems = problemsIn(body);
      if (problems.length) bad.push(`${v.name}: ${problems.join("; ")}`);
    }
    expect(bad).toEqual([]);
    expect(served).toBeGreaterThan(100);
  }, 300_000);
});

describe("entries whose declared type is not what they hold", () => {
  it("never serves script as a page: html types are sanitised, everything else is inert text or data under nosniff", async () => {
    const t = await startZimServer();
    const h = await hostile(t);
    const bad: string[] = [];
    for (const p of ["A/svg.svg", "A/doc.xhtml", "A/xml.xml", "A/js.js", "A/plain.txt", "A/html-as-png", "A/html-as-octet", "A/no-type", "A/utf7.html", "A/html-params", "A/css.css", "A/mhtml", "A/pdf.pdf", "A/swf"]) {
      const r = await h.get(p);
      if (r.status !== 200 && r.status !== 404) bad.push(`${p}: status ${r.status}`);
      HEADERS_OK(r, p);
      if (r.status !== 200) continue;
      const type = (r.headers.get("content-type") ?? "").toLowerCase();
      const body = await r.text();
      // anything the browser would parse as a document or script must have been cleaned
      if (/html|xhtml|xml|svg/.test(type)) {
        if (/svg|xml/.test(type)) {
          if (/<script|\son\w+\s*=|javascript:|attacker\.invalid|<foreignObject/i.test(body)) bad.push(`${p} (${type}): active content survived: ${body.slice(0, 120)}`);
        } else {
          const problems = problemsIn(body);
          if (problems.length) bad.push(`${p} (${type}): ${problems.join("; ")}`);
        }
      }
      if (/utf-7|iso-2022/.test(type)) bad.push(`${p}: charset ${type} reaches the browser`);
      if (type === "" ) bad.push(`${p}: no content type`);
      // html bytes under a non-html type must not be announced as html
      if (["A/html-as-png", "A/html-as-octet", "A/no-type", "A/plain.txt"].includes(p) && /html/.test(type)) bad.push(`${p}: announced as ${type}`);
      // the css entry must not carry imports or external urls
      if (p === "A/css.css" && /@import|attacker\.invalid|expression\(|behavior|-moz-binding/i.test(body)) bad.push(`css kept active parts: ${body.slice(0, 120)}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it("path tricks stay inside the package and answer with the standard headers", async () => {
    const t = await startZimServer();
    const h = await hostile(t);
    const token = h.base.replace(/^.*\/a\//, "");
    const port = t.archivePort as number;
    const headerOk = (r: { headers: http.IncomingHttpHeaders }, label: string) => {
      expect(String(r.headers["content-security-policy"] ?? ""), label).toMatch(/^sandbox/);
      expect(r.headers["x-content-type-options"], label).toBe("nosniff");
      expect(r.headers["set-cookie"], label).toBeUndefined();
    };
    for (const p of ["../../../etc/passwd", "..%2f..%2f..%2fetc%2fpasswd", "%2e%2e/%2e%2e/secret", "A/../../x", "A%2f..%2f..%2fx", "%00", "A/svg.svg%00.html", "A\\..\\x", "./A/js.js/", "A//js.js", "%25%32%66", "x".repeat(5000)]) {
      const r = await raw(port, `/a/${token}/z/${h.id}/${p}`);
      expect([200, 301, 302, 400, 401, 404, 414], `${p.slice(0, 40)} -> ${r.status}`).toContain(r.status);
      headerOk(r, p.slice(0, 40));
      expect(r.body).not.toContain("root:x:");
    }
    // a package id that is not this one, or traversal in the package position
    const base = h.base;
    for (const p of ["z/zim_nope/V0", "z/../V0", "z/%2e%2e/p/x", "z//V0", "z"]) {
      const r = await raw(port, `/a/${token}/${p}`);
      expect([200, 400, 401, 404], `${p} -> ${r.status}`).toContain(r.status);
      headerOk(r, p);
    }
  }, 120_000);
});

describe("markup in the package's own metadata", () => {
  it("is escaped in the bar above every page, and the package record carries it as a string, never as markup", async () => {
    const t = await startZimServer();
    const h = await hostile(t);
    const r = await h.get("Hostile_start");
    const html = await r.text();
    expect(html).toContain("data-ncb-zim-bar");
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("&lt;script&gt;");
    // the licence address field is only ever an http(s) address: the source `javascript:` text is kept as plain text, not as a link
    expect(JSON.stringify(h.pkg)).not.toMatch(/"url":"javascript:/i);
    const rec = await t.api("GET", `/api/zim/packages/${h.id}`);
    expect(rec.status).toBe(200);
    expect(typeof rec.body.title).toBe("string");
    const lic = rec.body.license?.url ?? null;
    expect(lic === null || /^https?:\/\//i.test(lic), String(lic)).toBe(true);
  }, 120_000);
});

describe("search results from a hostile package", () => {
  it("snippets keep <b> and nothing else, titles are escaped, in the package search and the combined search", async () => {
    const t = await startZimServer();
    const h = await hostile(t);
    const tagsOk = (s: string) => /^(?:[^<]|<\/?b>)*$/.test(s);
    const collect = (o: unknown, out: { key: string; value: string }[] = []) => {
      if (Array.isArray(o)) o.forEach((x) => collect(x, out));
      else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (typeof v === "string" && /snippet|html|highlight/i.test(k)) out.push({ key: k, value: v }); else collect(v, out); }
      return out;
    };
    let seen = 0;
    for (const q of ["xyzzyhostile", "hostile", "vector", "alert", "script", "onerror", "img"]) {
      const a = await t.api("GET", `/api/zim/packages/${h.id}/search?q=${encodeURIComponent(q)}`);
      expect(a.status, `${q}: ${JSON.stringify(a.body).slice(0, 200)}`).toBeLessThan(500);
      const b = await t.api("POST", "/api/search", { q, scope: "everywhere" });
      expect(b.status, `${q}: ${JSON.stringify(b.body).slice(0, 200)}`).toBeLessThan(500);
      for (const f of [...collect(a.body), ...collect(b.body)]) {
        seen++;
        expect(tagsOk(f.value), `${q} ${f.key}: ${f.value.slice(0, 160)}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  }, 120_000);
});
