import fs from "node:fs";
import readline from "node:readline";
import { createHash } from "node:crypto";
import type { IndexDoc } from "../src/types.js";

/** One line of docs/research/search-bench/data/corpus.jsonl (also produced synthetically by `scripts/search/synth-corpus.mjs`). */
export interface CorpusLine { id: number; title: string; headings: string[]; body: string; url: string; domain: string; collection: string; content_type: string; language: string; date: number }

const hashInt = (s: string): number => parseInt(createHash("md5").update(s).digest("hex").slice(0, 8), 16);

export function corpusToDoc(d: CorpusLine, offset = 0): IndexDoc {
  const h = hashInt(d.title + offset);
  return {
    pageId: d.id + 1 + offset, versionId: d.id + 1 + offset, publicPageId: `pg_${d.id + offset}`, url: offset ? `${d.url}?v=${offset}` : d.url, domain: d.domain, registrableDomain: d.domain.split(".").slice(-2).join("."),
    title: d.title, description: "", keywords: "", headings: d.headings.join("\n"), body: d.body, lang: d.language, type: "html", origin: "web",
    capturedAt: d.date * 1000, publishedAt: d.date * 1000, availability: "archived", priority: 3, inlinks: h % 25 === 0 ? h % 40 : 0,
    contentHash: createHash("sha1").update(d.title + d.body.slice(0, 200) + offset).digest("hex"),
    sourceIds: [`src_${d.collection}`], collectionIds: [`col_${d.collection}`],
  };
}

export async function* readCorpus(file: string, limit = Infinity): AsyncGenerator<CorpusLine> {
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (n++ >= limit) break;
    yield JSON.parse(line) as CorpusLine;
  }
}

export function corpusPath(): string {
  return process.env.NCB_SEARCH_CORPUS ?? new URL("../../../docs/research/search-bench/data/corpus.jsonl", import.meta.url).pathname;
}

export function corpusAvailable(): boolean {
  try { return fs.statSync(corpusPath()).size > 1_000_000; } catch { return false; }
}
