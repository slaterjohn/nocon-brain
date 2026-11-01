import type { ResourceKind } from "./types.js";

export interface ResourceEntry {
  /** The original absolute URL. */
  url: string;
  /** Archive key (`assetKey`, base-36 of the asset id). */
  key: string;
  contentType?: string;
}

/** Normal form used as the lookup key: fragment dropped, scheme and host lower-cased by the URL parser. */
export function normaliseResourceUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Maps original sub-resource URLs to archive keys for one version (built from `asset_references`).
 * `hrefFor` is a function so the table stays independent of the token and the version path.
 */
export class ResourceTable {
  private readonly byUrl = new Map<string, ResourceEntry>();

  constructor(entries: Iterable<ResourceEntry> = []) {
    for (const e of entries) this.add(e);
  }

  add(entry: ResourceEntry): void {
    const k = normaliseResourceUrl(entry.url);
    if (k) this.byUrl.set(k, { ...entry, url: k });
  }

  lookup(absUrl: string): ResourceEntry | undefined {
    const k = normaliseResourceUrl(absUrl);
    return k ? this.byUrl.get(k) : undefined;
  }

  get size(): number {
    return this.byUrl.size;
  }

  entries(): ResourceEntry[] {
    return [...this.byUrl.values()];
  }

  /** The reverse direction: archive key to the original URL (used to resolve relative URLs inside a CSS asset). */
  originalUrl(key: string): string | undefined {
    for (const e of this.byUrl.values()) if (e.key === key) return e.url;
    return undefined;
  }

  /** A `RewriteCallbacks.resource` implementation. A stylesheet is only linked when the archived copy is CSS-like. */
  resolver(hrefFor: (key: string) => string): (absUrl: string, kind: ResourceKind) => string | null {
    return (absUrl) => {
      const e = this.lookup(absUrl);
      return e ? hrefFor(e.key) : null;
    };
  }
}
