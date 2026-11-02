import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Fts5Index, type IndexDoc } from "../src/index.js";

let n = 0;
export function tmpFile(name = "index.db"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ncb-search-"));
  return path.join(d, name);
}

export function doc(over: Partial<IndexDoc> & { title: string; body: string }): IndexDoc {
  n++;
  return {
    pageId: n, versionId: n, publicPageId: `pg_${n}`, url: `https://example.org/p/${n}`, domain: "example.org", registrableDomain: "example.org",
    description: "", keywords: "", headings: "", lang: "en", type: "html", origin: "web", capturedAt: Date.UTC(2026, 0, 10), publishedAt: null,
    availability: "archived", priority: 3, inlinks: 0, contentHash: `h${n}`, sourceIds: [], collectionIds: [], ...over,
  };
}

/** A small English corpus with known answers. */
export function fixtureDocs(): IndexDoc[] {
  const long = (s: string) => `${s} `.repeat(1);
  return [
    doc({ title: "Astronomy", headings: "History\nBranches", body: long("Astronomy is the study of stars, planets, comets and galaxies. Astronomers observe the sky with telescopes. The solar system has eight planets.") }),
    doc({ title: "Planet", body: long("A planet is a large object that orbits a star. The planets of the solar system are Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus and Neptune. Mars is called the red planet.") }),
    doc({ title: "Mars", body: long("Mars is the fourth planet from the Sun. It has two small moons. Early astronomers discovered the canals illusion.") }),
    doc({ title: "Solar System", body: long("The solar system is the Sun and everything that orbits it, including planets, moons, asteroids and comets. Discovering new planets continues.") }),
    doc({ title: "Cooking pasta", body: long("Boil water, add salt, cook the pasta for ten minutes and drain. Serve with tomato sauce."), domain: "recipes.example.com", url: "https://recipes.example.com/pasta" }),
    doc({ title: "Moon", body: long("The Moon orbits the Earth every twenty seven days. Tides on Earth follow the Moon. The moon has craters."), capturedAt: Date.UTC(2020, 5, 1), publishedAt: Date.UTC(2019, 0, 1) }),
    doc({ title: "Quarterly report", body: long("Revenue grew while costs fell. The report covers the fiscal year."), type: "pdf", domain: "docs.example.org", url: "https://docs.example.org/report.pdf", publishedAt: Date.UTC(2025, 11, 31) }),
    doc({ title: "Fotografie", body: long("Die Fotografie ist ein bildgebendes Verfahren. Kamera und Licht sind wichtig für gute Bilder."), lang: "de", url: "https://example.de/foto", domain: "example.de" }),
    doc({ title: "Injection test", body: long("This page contains <script>alert(1)</script> and <img src=x onerror=alert(2)> inside the astronomy text &amp; more.") }),
  ];
}

export function buildFixture(docs = fixtureDocs()): { idx: Fts5Index; file: string; docs: IndexDoc[]; reader: Fts5Index } {
  const file = tmpFile();
  const idx = Fts5Index.create(file);
  idx.rebuild(docs, { generationId: 1, outboxStart: 0 });
  const reader = Fts5Index.openReader(file);
  return { idx, file, docs, reader };
}
