import { Readable } from "node:stream";
import { createHash } from "node:crypto";

/**
 * What the archive listener needs from the capture data. The listener has no database and no network code: the pipeline
 * supplies a real implementation; `MemoryCaptureStore` serves tests and an empty archive.
 */
export interface VersionRef {
  versionId: string;
  pageId: string;
  status: "ready" | "partial";
  /** Final URL the document was captured from (base for relative references). */
  url: string;
  /** Number of sub-resources that were not saved (drives the partial banner). */
  missingResources: number;
}

export interface DocumentBody {
  html: string;
  /** Final URL; usually equals `VersionRef.url`. */
  baseUrl: string;
}

export interface ReaderBody {
  title: string;
  html: string;
}

export interface ResourceRef {
  url: string;
  assetKey: string;
  contentType?: string;
}

export interface AssetHandle {
  contentType: string;
  size: number;
  /** Content hash, used (with the rewriter version) for the `ETag`. */
  sha256: string;
  /** A stream over the bytes `[start, end]` inclusive, or the whole asset. */
  open(range?: { start: number; end: number }): Readable;
  readAll(maxBytes: number): Promise<Buffer>;
}

/** What a link target currently is, for the link-state table in docs/api.md. */
export type LinkTarget =
  | { kind: "page"; pageId: string; status: "ready" | "partial" }
  | { kind: "queued" }
  | { kind: "zim"; zimId: string; path: string }
  | { kind: "unavailable" };

export interface ZimEntry {
  contentType: string;
  body: Buffer;
  /** Path to redirect to (relative to the same ZIM), when the entry is a redirect. */
  redirectTo?: string;
  /** The package's UUID: part of the `ETag`, because a ZIM never changes. */
  uuid?: string;
}

/** What the listener needs to know about a package to serve and link its entries. */
export interface ZimPackageRef {
  zimId: string;
  title: string;
  uuid: string;
  /** False for ZIMs written before libzim 7: their article paths hide an `A/` prefix and other namespaces show as `I/`, `-/`. */
  newNamespaceScheme: boolean;
  mainPath: string | null;
  language?: string | null;
  licenseName?: string | null;
  attribution?: string | null;
  /** For a Wikipedia package: the web address of an entry (`https://en.wikipedia.org/wiki/Benzene`), shown in the address bar and kept in History. */
  webUrl?(path: string): string | null;
}

/** The credit a page carries (CC BY-SA and similar): where the text came from, under which licence, and who made each image. */
export interface PageAttribution {
  licenseName: string | null;
  licenseUrl: string | null;
  sourceUrl: string | null;
  revisionId: string | null;
  historyUrl: string | null;
  creditText: string | null;
  /** When the copy was made (the version's fetch time, ms). */
  retrievedAt: number;
  images: { file: string | null; url: string | null; author: string | null; licenseName: string | null; licenseUrl: string | null; sourcePageUrl: string | null }[];
}

export interface CaptureStore {
  /** The latest ready or partial version of a page, or null. */
  latestVersion(pageId: string): Promise<VersionRef | null>;
  getVersion(versionId: string): Promise<VersionRef | null>;
  readDocument(version: VersionRef): Promise<DocumentBody | null>;
  readReader(version: VersionRef): Promise<ReaderBody | null>;
  /** All sub-resources of a version (its `asset_references`). Only these may be served under `v/{id}/r/{key}`. */
  listResources(versionId: string): Promise<ResourceRef[]>;
  /** The asset with this key, only if the version references it. */
  getAsset(versionId: string, assetKey: string): Promise<AssetHandle | null>;
  /** Batched link lookup by absolute URL (matches `url_key` and `page_aliases`). Absent keys are unarchived. */
  lookupLinks(urls: string[]): Promise<Map<string, LinkTarget>>;
  connectivity(): "online" | "offline";
  /** Called in batches with the version ids served since the last flush (`last_accessed_at`). */
  touchVersions(versionIds: string[], atMs: number): Promise<void> | void;
  /** The attribution footer data of a version, when it has any (Wikipedia pages do). */
  readAttribution?(versionId: string): Promise<PageAttribution | null>;
  getZimEntry?(zimId: string, path: string): Promise<ZimEntry | null>;
  /** The package behind a `z/{zimId}` URL, or null when it is unknown, not ready or not open. */
  zimPackage?(zimId: string): Promise<ZimPackageRef | null>;
  /** Which of these paths exist in the package (one batch per page, for link states). */
  zimExists?(zimId: string, paths: string[]): Promise<Set<string>>;
}

export class BufferAsset implements AssetHandle {
  readonly size: number;
  readonly sha256: string;
  constructor(readonly contentType: string, private readonly data: Buffer) {
    this.size = data.length;
    this.sha256 = createHash("sha256").update(data).digest("hex");
  }
  open(range?: { start: number; end: number }): Readable {
    return Readable.from([range ? this.data.subarray(range.start, range.end + 1) : this.data]);
  }
  async readAll(maxBytes: number): Promise<Buffer> {
    if (this.size > maxBytes) throw new Error("asset too large");
    return this.data;
  }
}

interface MemVersion extends VersionRef {
  html: string;
  reader?: ReaderBody;
  resources: Map<string, { url: string; asset: BufferAsset }>;
}

/** In-memory `CaptureStore` for tests and for a listener with no pipeline attached. */
export class MemoryCaptureStore implements CaptureStore {
  private readonly versions = new Map<string, MemVersion>();
  private readonly latest = new Map<string, string>();
  private readonly links = new Map<string, LinkTarget>();
  private readonly zims = new Map<string, ZimEntry>();
  private readonly zimPackages = new Map<string, ZimPackageRef>();
  online: "online" | "offline" = "online";
  readonly touched: { ids: string[]; at: number }[] = [];

  addVersion(v: {
    versionId: string;
    pageId: string;
    url: string;
    html: string;
    status?: "ready" | "partial";
    missingResources?: number;
    reader?: ReaderBody;
    resources?: { url: string; assetKey: string; contentType: string; body: Buffer | string }[];
  }): this {
    const resources = new Map<string, { url: string; asset: BufferAsset }>();
    for (const r of v.resources ?? []) {
      resources.set(r.assetKey, { url: r.url, asset: new BufferAsset(r.contentType, Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body)) });
    }
    this.versions.set(v.versionId, {
      versionId: v.versionId, pageId: v.pageId, url: v.url, html: v.html, status: v.status ?? "ready",
      missingResources: v.missingResources ?? 0, reader: v.reader, resources,
    });
    this.latest.set(v.pageId, v.versionId);
    return this;
  }

  /** Registers what a URL is, for link lookups. */
  setLink(url: string, target: LinkTarget): this {
    this.links.set(url, target);
    return this;
  }

  setZimEntry(zimId: string, path: string, entry: ZimEntry): this {
    this.zims.set(`${zimId}/${path}`, entry);
    return this;
  }

  setZimPackage(ref: ZimPackageRef): this {
    this.zimPackages.set(ref.zimId, ref);
    return this;
  }

  async latestVersion(pageId: string) {
    const id = this.latest.get(pageId);
    return id ? this.getVersion(id) : null;
  }
  async getVersion(versionId: string) {
    const v = this.versions.get(versionId);
    return v ? { versionId: v.versionId, pageId: v.pageId, status: v.status, url: v.url, missingResources: v.missingResources } : null;
  }
  async readDocument(version: VersionRef) {
    const v = this.versions.get(version.versionId);
    return v ? { html: v.html, baseUrl: v.url } : null;
  }
  async readReader(version: VersionRef) {
    return this.versions.get(version.versionId)?.reader ?? null;
  }
  async listResources(versionId: string) {
    const v = this.versions.get(versionId);
    return v ? [...v.resources].map(([assetKey, r]) => ({ url: r.url, assetKey, contentType: r.asset.contentType })) : [];
  }
  async getAsset(versionId: string, assetKey: string) {
    return this.versions.get(versionId)?.resources.get(assetKey)?.asset ?? null;
  }
  async lookupLinks(urls: string[]) {
    const out = new Map<string, LinkTarget>();
    for (const u of urls) {
      const t = this.links.get(u) ?? this.links.get(u.replace(/#.*$/, ""));
      if (t) out.set(u, t);
    }
    return out;
  }
  connectivity() {
    return this.online;
  }
  touchVersions(ids: string[], at: number) {
    this.touched.push({ ids, at });
  }
  async getZimEntry(zimId: string, path: string) {
    return this.zims.get(`${zimId}/${path}`) ?? null;
  }
  async zimPackage(zimId: string): Promise<ZimPackageRef | null> {
    const set = this.zimPackages.get(zimId);
    if (set) return set;
    // A package with entries but no explicit registration behaves as a current-scheme package.
    for (const k of this.zims.keys()) if (k.startsWith(`${zimId}/`)) return { zimId, title: zimId, uuid: zimId, newNamespaceScheme: true, mainPath: null };
    return null;
  }
  async zimExists(zimId: string, paths: string[]) {
    return new Set(paths.filter((p) => this.zims.has(`${zimId}/${p}`)));
  }
}
