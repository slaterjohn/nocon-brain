// Generates the small fixture ZIM files used by the Phase 8 tests (tasks Z-01 to Z-09) with the libzim `Creator` API.
// All content below is written for this project and is licensed AGPL-3.0-only like the rest of the repository. No ZIM is downloaded.
//
//   node tests/fixtures/zim/build.mjs [outDir]
//
// Produces in outDir (default tests/fixtures/zim/.cache):
//   chem.zim       new namespace scheme, full-text index, title index, images, CSS, a script, links between entries, redirects
//   notitle.zim    no full-text index (title-suggestion fallback), otherwise like chem.zim but tiny
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
const RAW = { [CHEM_UUID]: "ncb-fixture-chem", [NOTITLE_UUID]: "ncb-fixture-note", [OTHER_UUID]: "ncb-fixture-cuis", [BIG_UUID]: "ncb-fixture-bigg" };

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

async function build(file, { uuid, title, fulltext, articles, language = "eng", flavour = "maxi", extraMeta = {}, redirects = true, extraItems = [] }) {
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

/** Builds every fixture into `outDir` (skipping files that already exist unless `force`). Returns their paths. */
export async function buildFixtures(outDir = path.join(here, ".cache"), { force = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = { big: path.join(outDir, "big.zim"), chem: path.join(outDir, "chem.zim"), notitle: path.join(outDir, "notitle.zim"), other: path.join(outDir, "other.zim"), bad: path.join(outDir, "bad.zim") };
  if (force || !fs.existsSync(out.chem)) await build(out.chem, { uuid: CHEM_UUID, title: "Chemistry (fixture)", fulltext: true, articles: CHEM_ARTICLES });
  if (force || !fs.existsSync(out.notitle)) {
    await build(out.notitle, {
      uuid: NOTITLE_UUID, title: "Notes without a full-text index", fulltext: false, flavour: "nopic", language: "eng",
      redirects: false, articles: [["Aromatic_notes", "Aromatic notes", `<p>Notes about aromatic rings, but nothing indexes this text.</p>`], ["Alkane_notes", "Alkane notes", `<p>Alkanes are saturated.</p>`]],
    });
  }
  if (force || !fs.existsSync(out.other)) {
    await build(out.other, {
      uuid: OTHER_UUID, title: "Cuisine (fixture)", fulltext: true, language: "fra", flavour: "mini",
      redirects: false, articles: [["Pain", "Pain", `<p>Le pain est une aromatic base de la cuisine.</p>`], ["Fromage", "Fromage", `<p>Le fromage est fait de lait.</p>`]],
    });
  }
  if (force || !fs.existsSync(out.big)) {
    // About 24 MiB of incompressible media in a few articles: proves that registering a package reads in place and extracts nothing.
    const { randomBytes } = await import("node:crypto");
    await build(out.big, {
      uuid: BIG_UUID, title: "Large package (fixture)", fulltext: false, flavour: "maxi", redirects: false,
      articles: [["Big_article", "Big article", `<p>Large package.</p><img src="I/blob0.bin">`]],
      extraItems: Array.from({ length: 6 }, (_, i) => [`I/blob${i}.bin`, "application/octet-stream", `blob${i}`, randomBytes(4 * 1024 * 1024)]),
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
