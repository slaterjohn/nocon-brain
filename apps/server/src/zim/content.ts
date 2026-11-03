import type { ZimEntry, ZimPackageRef } from "../archive/store.js";
import type { ZimService } from "./service.js";
import type { ZimSource } from "./source.js";
import { twoLetterLanguage } from "./languages.js";
import { articleUrl } from "../wikipedia/url.js";
import { isWikipediaPackage } from "../wikipedia/zim-map.js";

/** The listener's view of the packages (task Z-04): reads one entry at a time through the `zim` worker, never touching the database per request beyond one lookup. */
export class ZimContent {
  constructor(private readonly o: { zim: ZimService; source: ZimSource }) {}

  private async ready(zimId: string) {
    let row;
    try {
      row = this.o.zim.rowByPublic(zimId);
    } catch {
      return null;
    }
    if (row.state === "missing" || row.state === "importing" || row.state === "removing") return null;
    return (await this.o.zim.ensureOpen(row)) ? row : null;
  }

  async package(zimId: string): Promise<ZimPackageRef | null> {
    const r = await this.ready(zimId);
    if (!r) return null;
    const lang = isWikipediaPackage(r) ? twoLetterLanguage(r.language) : undefined;
    return {
      zimId, title: r.title, uuid: r.uuid, newNamespaceScheme: r.new_namespace_scheme === 1, mainPath: r.main_path, language: r.language,
      licenseName: r.license_name, attribution: r.attribution_text,
      ...(lang ? { webUrl: (p: string) => (/[?#]/.test(p) ? null : articleUrl({ lang, title: p })) } : {}),
    };
  }

  async entry(zimId: string, path: string): Promise<ZimEntry | null> {
    const r = await this.ready(zimId);
    if (!r) return null;
    try {
      const e = await this.o.source.readEntry(zimId, path, { follow: false });
      if (e.kind === "missing") return null;
      if (e.kind === "redirect") return { contentType: "text/plain", body: Buffer.alloc(0), redirectTo: e.target, uuid: r.uuid };
      return { contentType: e.mimeType, body: Buffer.from(e.data), uuid: r.uuid };
    } catch {
      // A damaged or restarting package answers as if the entry were absent; the health state tells the Human why.
      return null;
    }
  }

  async exists(zimId: string, paths: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    const r = await this.ready(zimId);
    if (!r) return out;
    await Promise.all(paths.map(async (p) => {
      try {
        if (p && (await this.o.source.hasEntry(zimId, p))) out.add(p);
      } catch { /* treated as missing */ }
    }));
    return out;
  }
}
