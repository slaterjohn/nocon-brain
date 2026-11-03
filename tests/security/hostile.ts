import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";
import { createSsrfGuard, type Resolver } from "@ncb/fetch";
import { FAKE_DNS, directTargets, redirectLocations } from "./ssrf-corpus.js";

export const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

export function listen(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, server }));
    closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  });
}

/** Counts every request. Loopback spellings of the corpus point here. */
export async function startCanary() {
  const hits: string[] = [];
  const { port } = await listen((req, res) => {
    hits.push(`${req.method} ${req.headers.host}${req.url}`);
    res.setHeader("content-type", "text/html");
    res.end("<title>CANARY</title><h1>the SSRF guard did not stop this request</h1>");
  });
  return { port, hits };
}

/** The fake DNS: hostile names answer with disallowed addresses; good.test answers loopback (and is the one allowed host). */
export const resolver: Resolver = async (host) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "good.test") return [{ address: "127.0.0.1", family: 4 }];
  const key = Object.keys(FAKE_DNS).find((k) => k.toLowerCase().replace(/\.$/, "") === h);
  if (key) return FAKE_DNS[key]!.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
  return [{ address: "127.0.0.1", family: 4 }]; // any other name would reach loopback, which is refused
};
export const makeGuard = () => createSsrfGuard({ allow: "good.test", resolver });

export type SiteMode = { robots: "normal" | "redirect" | "sitemaps" | "disallow-private" };

/** The hostile site. Everything it links to, embeds, redirects to or lists is a corpus target. */
export async function startHostileSite(canary: number, mode: SiteMode = { robots: "normal" }) {
  const served: string[] = [];
  const targets = directTargets(canary).filter((t) => /^https?:/i.test(t.url) && !t.name.startsWith("port ")); // port targets need a public name
  const urls = targets.map((t) => t.url);
  const redirects = redirectLocations(canary);
  const sample = (n: number) => urls.filter((_, i) => i % Math.max(1, Math.floor(urls.length / n)) === 0);
  let origin = "";
  const { port } = await listen((req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    served.push(p);
    const html = (body: string, type = "text/html; charset=utf-8") => { res.setHeader("content-type", type); res.end(body); };
    if (p === "/robots.txt") {
      if (mode.robots === "redirect") { res.writeHead(302, { location: `http://127.0.0.1:${canary}/robots.txt` }).end(); return; }
      if (mode.robots === "sitemaps") return html(`User-agent: *\nAllow: /\n${sample(40).map((u) => `Sitemap: ${u}`).join("\n")}\nSitemap: ${origin}/sitemap.xml\n`, "text/plain");
      if (mode.robots === "disallow-private") return html(`User-agent: *\nDisallow: /private\n`, "text/plain");
      return html("User-agent: *\nAllow: /\n", "text/plain");
    }
    const m = /^\/redir\/(\d+)$/.exec(p);
    if (m) {
      const r = redirects[Number(m[1])];
      if (!r) { res.writeHead(404).end(); return; }
      res.writeHead([301, 302, 303, 307, 308][Number(m[1]) % 5]!, { location: r.location }).end();
      return;
    }
    if (p === "/chain") { res.writeHead(302, { location: "/redir/0" }).end(); return; }
    if (p === "/good-then-private") { res.writeHead(302, { location: "/page-ok" }).end(); return; }
    if (p === "/page-ok") return html("<!doctype html><title>OK</title><main><article><h1>OK</h1><p>A harmless page on the allowed host.</p></article></main>");
    if (p === "/asset/hostile.css") {
      return html(`${sample(6).map((u) => `@import url("${u}");`).join("\n")}\nbody{background:url(${sample(3)[0]})}\n@font-face{font-family:x;src:url("${sample(4)[1]}")}\n`, "text/css");
    }
    if (p === "/img.png") { res.setHeader("content-type", "image/png"); res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64")); return; }
    if (p === "/sitemap.xml") {
      return html(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/page-ok</loc></url>${urls.map((u) => `<url><loc>${u.replace(/&/g, "&amp;")}</loc></url>`).join("")}</urlset>`, "application/xml");
    }
    if (p === "/sitemap-index.xml") {
      return html(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sample(30).map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join("")}<sitemap><loc>${origin}/sitemap.xml</loc></sitemap></sitemapindex>`, "application/xml");
    }
    if (p === "/feed.xml") {
      return html(`<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><link>${origin}/</link><item><title>ok</title><link>${origin}/page-ok</link><guid>ok</guid></item>${urls.map((u, i) => `<item><title>t${i}</title><link>${u.replace(/&/g, "&amp;")}</link><guid>g${i}</guid></item>`).join("")}</channel></rss>`, "application/rss+xml");
    }
    if (p === "/page-base") {
      // relative references resolve against the base, which is the canary: a guard that trusts the page's own idea of its address fails here
      return html(`<!doctype html><html><head><title>Base</title><base href="http://127.0.0.1:${canary}/"></head><body><main><h1>Base</h1><a href="next">next</a><img src="a.png"><link rel="stylesheet" href="s.css"></main></body></html>`);
    }
    if (p === "/page" || p === "/") {
      const s = sample(60);
      return html(`<!doctype html><html lang="en"><head><title>Hostile page</title>
<link rel="stylesheet" href="/asset/hostile.css"><link rel="canonical" href="${s[0]}"><link rel="alternate" type="application/rss+xml" href="${s[1]}">
<link rel="preload" as="image" href="${s[2]}"><link rel="icon" href="${s[3]}"><link rel="next" href="${s[4]}"><meta http-equiv="refresh" content="3;url=${s[5]}">
<meta property="og:image" content="${s[6]}"><script src="${s[7]}"></script></head><body><main><article><h1>Hostile page</h1>
<p>Text long enough to be an article so the extractor keeps it. ${"Lorem ipsum dolor sit amet. ".repeat(20)}</p>
${s.map((u, i) => `<a href="${u}">link ${i}</a>`).join("\n")}
${s.slice(0, 20).map((u) => `<img src="${u}">`).join("\n")}
<img srcset="${s.slice(0, 5).map((u, i) => `${u} ${i + 1}x`).join(", ")}" src="/img.png">
<picture>${s.slice(5, 8).map((u) => `<source srcset="${u}">`).join("")}<img src="/img.png"></picture>
<iframe src="${s[8]}"></iframe><object data="${s[9]}"></object><embed src="${s[10]}"><video poster="${s[11]}" src="${s[12]}"></video><audio src="${s[13]}"></audio>
<form action="${s[14]}"><button>go</button></form><div style="background:url(${s[15]})">x</div>
${redirects.map((_, i) => `<a href="/redir/${i}">redirect ${i}</a><img src="/redir/${i}">`).join("\n")}
<a href="${origin}/page-ok">fine</a></article></main></body></html>`);
    }
    res.writeHead(404).end("nope");
  });
  origin = `http://good.test:${port}`;
  return { port, origin, served };
}

export const SAME_HOST = new Set(["single-slash-scheme", "no-slash-scheme"]);
export const stride = <T,>(list: T[], n: number): T[] => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0);

