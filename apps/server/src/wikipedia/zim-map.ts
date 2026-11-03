import { languageMatches } from "../zim/languages.js";
import type { ZimRow, ZimService } from "../zim/service.js";
import type { ZimSource } from "../zim/source.js";
import { parseWikipediaUrl, zimPathOf, type WikiTarget, type WikiUrlOptions } from "./url.js";

export interface ZimEntryRef {
  zimId: string;
  path: string;
  title: string;
  language: string | null;
}

/** A package is a Wikipedia package when its metadata says so (Kiwix names them `wikipedia_en_all_maxi` and so on). */
export function isWikipediaPackage(r: Pick<ZimRow, "name" | "title" | "creator" | "publisher" | "source_url">): boolean {
  return /wikipedia/i.test(`${r.name} ${r.title} ${r.source_url ?? ""}`) || /wikipedia|wikimedia/i.test(`${r.creator ?? ""} ${r.publisher ?? ""}`);
}

const CACHE_MAX = 20_000;

/**
 * Maps a Wikipedia article to the same article in an enabled Wikipedia knowledge package of its language (task Z-06). Used by `resolve`
 * (a typed address), by the listener (links on archived pages) and by search (de-duplication). A ZIM never changes, so answers are
 * cached by package and path; the package id is part of the key, so a package that is removed or replaced starts clean.
 */
export class WikipediaZim {
  private readonly cache = new Map<string, boolean>();

  constructor(private readonly o: { zim: ZimService; source: ZimSource; urlOptions: () => WikiUrlOptions }) {}

  /** Enabled packages of this language, best first (priority, then oldest). Empty without any Wikipedia package, which is the common case. */
  packages(lang: string): ZimRow[] {
    return this.o.zim.rows()
      .filter((r) => r.enabled_for_search === 1 && (r.state === "ready" || r.state === "degraded") && isWikipediaPackage(r) && languageMatches(r.language, [lang]))
      .sort((a, b) => a.priority - b.priority || a.id - b.id);
  }

  hasAny(): boolean {
    return this.o.zim.rows().some((r) => r.enabled_for_search === 1 && isWikipediaPackage(r));
  }

  private remember(key: string, v: boolean): boolean {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, v);
    return v;
  }

  private async has(r: ZimRow, path: string): Promise<boolean> {
    const key = `${r.public_id}\0${path}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    try {
      if (!(await this.o.zim.ensureOpen(r))) return false; // not cached: the package may come back
      return this.remember(key, await this.o.source.hasEntry(r.public_id, path));
    } catch {
      return false;
    }
  }

  /** The entry for an article, or undefined. */
  async find(t: WikiTarget): Promise<ZimEntryRef | undefined> {
    const path = zimPathOf(t);
    for (const r of this.packages(t.lang)) {
      if (await this.has(r, path)) return { zimId: r.public_id, path, title: r.title, language: r.language };
    }
    return undefined;
  }

  /** The article an address names (any language host, mobile host, `/wiki/` or `index.php?title=`), whether or not a package has it. */
  target(url: string): WikiTarget | undefined {
    return parseWikipediaUrl(url, this.o.urlOptions());
  }

  urlOptions(): WikiUrlOptions {
    return this.o.urlOptions();
  }

  /** The entry an address stands for, or undefined when the address is not a Wikipedia article or no package has it. */
  async findUrl(url: string): Promise<(ZimEntryRef & { target: WikiTarget }) | undefined> {
    const target = parseWikipediaUrl(url, this.o.urlOptions());
    if (!target) return undefined;
    const e = await this.find(target);
    return e ? { ...e, target } : undefined;
  }

  /** Which of these titles some package has (one pass, in chunks, for the crawl's ZIM-first rule). */
  async present(lang: string, titles: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    const pkgs = this.packages(lang);
    if (pkgs.length === 0) return out;
    for (let i = 0; i < titles.length; i += 100) {
      await Promise.all(titles.slice(i, i + 100).map(async (t) => {
        for (const r of pkgs) if (await this.has(r, t)) { out.add(t); return; }
      }));
    }
    return out;
  }
}
