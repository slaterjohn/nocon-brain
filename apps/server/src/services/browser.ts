import type { Clock, ResolvedConfig } from "@ncb/shared";
import { AppError, ulid } from "@ncb/shared";
import type { Db } from "@ncb/db";
import { FetchError, normaliseUrl, type FetchResult } from "@ncb/fetch";
import type { ArchiveListener } from "../archive/listener.js";
import { TOKEN_LIFETIME_SECONDS } from "../archive/tokens.js";
import type { PageDetail, PipelineService, VersionDetail } from "../pipeline/service.js";
import type { ConnectivityService } from "./connectivity.js";
import type { SettingsService } from "./settings.js";
import type { HistoryService } from "./bookmarks.js";

/** The `sandbox` attribute value for the archived-content iframe. No `allow-scripts`, no `allow-same-origin` (A-14). */
export const FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

export type LinkStateName = "cached" | "partial" | "live_only" | "queued" | "unavailable";
export type Connectivity = "online" | "offline" | "unknown";

export interface PageSummary {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  domain: string;
  type: "html";
  language?: string;
  availability: "archived" | "partial" | "evicted" | "failed";
  effectivePriority: "P1" | "P2" | "P3" | "P4";
  latestVersionId?: string;
  versionCount: number;
  firstCapturedAt?: string;
  lastCapturedAt?: string;
  inboundCount: number;
  /** Extension to docs/api.md: bytes of the latest version, for the library list. */
  totalBytes?: number;
}

export interface ApiVersionSummary {
  id: string;
  pageId: string;
  versionNo: number;
  status: string;
  partialReason?: string;
  fetchedAt: string;
  publishedAt?: string;
  publishedSource?: string;
  totalBytes: number;
  renderMode: "plain" | "browser";
}

export interface FrameInfo {
  url: string;
  frameId: string;
  expiresAt: string;
  sandbox: string;
}

export type Resolution =
  | { kind: "search"; query: string }
  | { kind: "archive"; page: PageSummary; version: ApiVersionSummary; mode: "original" | "reader"; frame: FrameInfo }
  | { kind: "live"; url: string; frameable: boolean | "unknown"; canSave: true; queued?: { downloadId: string } }
  | {
      kind: "offline"; url: string; reason: "offline" | "forced_offline" | "blocked" | "not_archived"; canQueue: boolean;
      queued?: { downloadId: string };
    };

export interface ResolveResponse {
  normalizedUrl: string;
  urlKey: string;
  resolution: Resolution;
  alternatives: ("archive" | "cache" | "zim" | "live" | "reader")[];
  connectivity: Connectivity;
}

export interface LinkState {
  url: string;
  state: LinkStateName;
  pageId?: string;
  progress?: { downloadJobId: string; percent?: number };
}

export interface FrameStateDto {
  frameId: string;
  url: string;
  title?: string;
  state: LinkStateName | "zim";
  pageId?: string;
  versionId?: string;
  reader?: boolean;
  interstitial?: boolean;
  at: string;
  seq: number;
}

export interface LiveCheck {
  url: string;
  reachable: boolean;
  status?: number;
  finalUrl?: string;
  /** Whether the site's headers allow it to be framed by this app. */
  frameable: boolean | "unknown";
  reason?: "x_frame_options" | "frame_ancestors" | "unreachable";
}

const prio = (n: number | null | undefined): PageSummary["effectivePriority"] => (`P${n && n >= 1 && n <= 4 ? n : 3}` as PageSummary["effectivePriority"]);
const isoOrUndef = (ms: number | null | undefined): string | undefined => (ms == null ? undefined : new Date(ms).toISOString());
const HOST_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const IPV4_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:[/?#]\S*)?$/;
const LOCAL_LIKE = /^(?:localhost|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#]\S*)?$/i;

export type InputKind = { kind: "url"; url: string } | { kind: "search"; query: string } | { kind: "unsupported"; scheme: string };

/**
 * What the address bar text means: a web address (with or without a scheme), a host-like word, or search terms. Other schemes
 * (`javascript:`, `data:`, `file:` and so on) are refused rather than searched for, so a pasted link never does something surprising.
 */
export function classifyInput(raw: string): InputKind {
  const input = raw.trim();
  if (!input) return { kind: "search", query: "" };
  const scheme = /^([a-z][a-z0-9+.-]*):([\s\S]*)$/i.exec(input);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    if (name === "http" || name === "https") return /^https?:\/\/\S+$/i.test(input) ? { kind: "url", url: input } : { kind: "search", query: input };
    // `localhost:3000` and `example.com:8080/x` parse as a scheme followed by a port; they are hosts.
    if (!/^\d{1,5}(?:[/?#]|$)/.test(scheme[2]!)) return /\s/.test(input) ? { kind: "search", query: input } : { kind: "unsupported", scheme: name };
  }
  if (/\s/.test(input)) return { kind: "search", query: input };
  if (IPV4_LIKE.test(input) || LOCAL_LIKE.test(input)) return { kind: "url", url: `http://${input}` };
  if (HOST_LIKE.test(input)) return { kind: "url", url: `https://${input}` };
  return { kind: "search", query: input };
}

export interface BrowserServiceOptions {
  db: Db;
  clock: Clock;
  config: ResolvedConfig;
  settings: SettingsService;
  connectivity: ConnectivityService;
  pipeline: PipelineService;
  archive?: ArchiveListener;
  history: HistoryService;
  /** Row id of the built-in "Quick saves" source. Saves made through `save` are linked to it (`page_sources`). */
  quickSavesSourceId?: () => number;
  /** A guarded `HEAD`; the server wires `@ncb/fetch` through the connectivity guard. */
  head(url: string, signal?: AbortSignal): Promise<Pick<FetchResult, "status" | "finalUrl" | "headers">>;
}

/**
 * The URL flow behind the address bar (docs/api.md section 3, A-16). `resolve` never fetches: it normalises, looks in the
 * archive, then decides between the archived copy, the live site and the offline page from what the connectivity service
 * already knows. Archive tokens are minted here, so the listener never needs a database.
 */
export class BrowserService {
  private readonly idempotency = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly o: BrowserServiceOptions) {}

  // ---- URLs and the archive ------------------------------------------------------------------

  private key(url: string): string {
    return this.o.pipeline.urlKey(url);
  }

  connectivityState(): Connectivity {
    return this.o.connectivity.snapshot().state;
  }

  /** The public address of the archive listener, as the browser should use it. */
  archiveBase(forwardedHost?: string): string {
    const fixed = this.o.config.NCB_ARCHIVE_PUBLIC_URL;
    if (fixed) return fixed.replace(/\/+$/, "");
    const app = new URL(this.o.config.NCB_APP_URL);
    let hostname = app.hostname;
    if (forwardedHost) {
      const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(forwardedHost.trim());
      if (m) hostname = m[1]!;
    }
    return `${app.protocol}//${hostname}:${this.o.config.NCB_ARCHIVE_PORT}`;
  }

  pageSummary(p: PageDetail): PageSummary {
    const bytes = p.latestVersionId ? this.o.db.get<{ n: number | null }>("SELECT total_bytes AS n FROM page_versions WHERE id = ?", [p.latestVersionId])?.n : undefined;
    return {
      id: p.publicId, url: p.canonicalUrl, canonicalUrl: p.canonicalUrl, title: p.title ?? p.canonicalUrl, domain: p.host, type: "html",
      ...(p.language ? { language: p.language } : {}),
      availability: p.availability as PageSummary["availability"], effectivePriority: prio(p.effectivePriority),
      ...(p.latestVersionPublicId ? { latestVersionId: p.latestVersionPublicId } : {}),
      versionCount: p.versionCount, inboundCount: p.inboundCount,
      ...(p.firstCapturedAt ? { firstCapturedAt: isoOrUndef(p.firstCapturedAt) } : {}),
      ...(p.lastCapturedAt ? { lastCapturedAt: isoOrUndef(p.lastCapturedAt) } : {}),
      ...(bytes != null ? { totalBytes: bytes } : {}),
    };
  }

  versionSummary(v: VersionDetail): ApiVersionSummary {
    const renderMode = this.o.db.get<{ render_mode: "plain" | "browser" }>("SELECT render_mode FROM page_versions WHERE id = ?", [v.id])?.render_mode ?? "plain";
    return {
      id: v.publicId, pageId: v.pagePublicId, versionNo: v.versionNo, status: v.status,
      ...(v.partialReason ? { partialReason: v.partialReason } : {}),
      fetchedAt: isoOrUndef(v.fetchedAt)!, ...(v.publishedAt ? { publishedAt: isoOrUndef(v.publishedAt) } : {}),
      ...(v.publishedSource ? { publishedSource: v.publishedSource } : {}),
      totalBytes: v.totalBytes ?? 0, renderMode,
    };
  }

  /** The page for a URL when it has a version a reader can open (`ready` or `partial`), with that version. */
  findUsable(url: string): { page: PageDetail; version: VersionDetail } | undefined {
    const page = this.o.pipeline.findPageByUrl(url);
    if (!page || page.latestVersionId == null) return undefined;
    if (page.availability !== "archived" && page.availability !== "partial") return undefined;
    const version = this.o.pipeline.getVersion(page.latestVersionId);
    if (!version || (version.status !== "ready" && version.status !== "partial")) return undefined;
    return { page, version };
  }

  private queuedFor(urlKey: string): { downloadId: string } | undefined {
    const r = this.o.db.get<{ public_id: string }>(
      `SELECT d.public_id FROM jobs j JOIN download_jobs d ON d.id = j.download_job_id
       WHERE j.type = 'fetch' AND j.url_key = ? AND j.state IN ('queued','running','held') ORDER BY j.id DESC LIMIT 1`, [urlKey]);
    return r ? { downloadId: r.public_id } : undefined;
  }

  // ---- frame grants --------------------------------------------------------------------------

  /** Mints an archive capability for one page or version and returns the iframe address. */
  mintFrame(input: { userId: number; pageId?: string; versionId?: string; mode?: "original" | "reader"; forwardedHost?: string }): FrameInfo {
    const tokens = this.o.archive?.tokens();
    if (!tokens) throw new AppError("internal", "The archive is not ready yet. Try again in a few seconds.");
    const frameId = `fr_${ulid()}`;
    const token = tokens.mint({ userId: String(input.userId), frameId, appOrigin: this.o.config.NCB_APP_URL });
    const target = input.versionId ? `v/${encodeURIComponent(input.versionId)}` : `p/${encodeURIComponent(input.pageId ?? "")}`;
    const url = `${this.archiveBase(input.forwardedHost)}/a/${token}/${target}${input.mode === "reader" ? "/reader" : ""}`;
    return { url, frameId, expiresAt: new Date(this.o.clock.now() + TOKEN_LIFETIME_SECONDS * 1000).toISOString(), sandbox: FRAME_SANDBOX };
  }

  frameGrant(input: { userId: number; pageId?: string; versionId?: string; mode?: "original" | "reader"; forwardedHost?: string }): FrameInfo {
    if (input.versionId) {
      const v = this.o.pipeline.getVersion(input.versionId);
      if (!v || (v.status !== "ready" && v.status !== "partial")) throw new AppError("not_found", "That saved copy does not exist.");
    } else if (input.pageId) {
      const p = this.o.pipeline.getPage(input.pageId);
      if (!p || p.latestVersionId == null) throw new AppError("not_found", "That page is not saved.");
    } else {
      throw new AppError("bad_request", "Say which page or version to open.");
    }
    return this.mintFrame(input);
  }

  // ---- resolve -------------------------------------------------------------------------------

  resolve(input: {
    userId: number;
    input: string;
    prefer?: "archive" | "live" | "reader";
    versionId?: string;
    forwardedHost?: string;
  }): ResolveResponse {
    const conn = this.connectivityState();
    const kind = classifyInput(input.input);
    if (kind.kind === "unsupported") {
      throw new AppError("bad_request", `Addresses starting with "${kind.scheme}:" cannot be opened here. Use a web address that starts with http or https.`, { kind: "unsupported_scheme" });
    }
    if (kind.kind === "search") {
      if (!kind.query) throw new AppError("bad_request", "Enter a web address or some search terms.");
      return { normalizedUrl: "", urlKey: "", resolution: { kind: "search", query: kind.query }, alternatives: [], connectivity: conn };
    }

    // 1. Normalise.
    let display: string;
    let urlKey: string;
    try {
      const n = normaliseUrl(kind.url, { queryPolicy: "keep_all" });
      if (n.hasCredentials) throw new AppError("bad_request", "Addresses with a username or password cannot be opened.", { kind: "credentials" });
      display = n.fetchUrl;
      urlKey = this.key(n.fetchUrl);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("bad_request", "That is not a web address. Check it and try again.", { kind: "invalid_url" });
    }

    // 2. Check the archive (a pinned version wins over the latest one).
    let usable = this.findUsable(display);
    if (input.versionId) {
      const v = this.o.pipeline.getVersion(input.versionId);
      if (v && (v.status === "ready" || v.status === "partial")) {
        const page = this.o.pipeline.getPage(v.pageId);
        if (page) usable = { page, version: v };
      }
    }
    const online = conn !== "offline";
    const preferCached = (this.o.settings.internal("browser") as { preferCached?: boolean }).preferCached !== false;
    const wantLive = input.prefer === "live" || (input.prefer === undefined && !preferCached);

    const alternatives: ResolveResponse["alternatives"] = [];
    if (usable) alternatives.push("archive", "reader");
    if (online) alternatives.push("live");

    // 3. Cached: open the archived copy, unless the Human asked for the live site and it can be reached.
    if (usable && !(wantLive && online)) {
      const mode = input.prefer === "reader" && usable.version.content.readerSha256 ? "reader" : "original";
      const frame = this.mintFrame({ userId: input.userId, pageId: usable.page.publicId, versionId: input.versionId ? usable.version.publicId : undefined, mode, forwardedHost: input.forwardedHost });
      return {
        normalizedUrl: display, urlKey, connectivity: conn, alternatives,
        resolution: { kind: "archive", page: this.pageSummary(usable.page), version: this.versionSummary(usable.version), mode, frame },
      };
    }

    const queued = this.queuedFor(urlKey);
    // 4 and 5. Online (or not known to be offline) and not cached: the live site, with an offer to save it.
    if (online) {
      return {
        normalizedUrl: display, urlKey, connectivity: conn, alternatives,
        resolution: { kind: "live", url: display, frameable: "unknown", canSave: true, ...(queued ? { queued } : {}) },
      };
    }
    // 6 and 7. Offline and not cached: the offline page, with an offer to queue the address.
    return {
      normalizedUrl: display, urlKey, connectivity: conn, alternatives,
      resolution: {
        kind: "offline", url: display, reason: this.o.connectivity.forced ? "forced_offline" : "offline", canQueue: true, ...(queued ? { queued } : {}),
      },
    };
  }

  /** Data for the offline page. */
  offlinePage(url: string): { url: string; reason: "offline" | "forced_offline" | "not_archived"; canQueue: boolean; archived: boolean; queued?: { downloadId: string }; connectivity: Connectivity } {
    const n = this.normalise(url);
    const conn = this.connectivityState();
    const queued = this.queuedFor(this.key(n));
    const archived = !!this.findUsable(n);
    return {
      url: n, connectivity: conn, archived, canQueue: true, ...(queued ? { queued } : {}),
      reason: this.o.connectivity.forced ? "forced_offline" : conn === "offline" ? "offline" : "not_archived",
    };
  }

  normalise(url: string): string {
    try {
      const n = normaliseUrl(url, { queryPolicy: "keep_all" });
      if (n.hasCredentials) throw new AppError("bad_request", "Addresses with a username or password cannot be used.", { kind: "credentials" });
      return n.fetchUrl;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("bad_request", "That is not a web address. Check it and try again.", { kind: "invalid_url" });
    }
  }

  // ---- link states ---------------------------------------------------------------------------

  linkStates(urls: string[]): LinkState[] {
    const offline = this.connectivityState() === "offline";
    const { db } = this.o;
    return urls.map((url) => {
      let n: string;
      try {
        n = this.normalise(url);
      } catch {
        return { url, state: "unavailable" as const };
      }
      const page = this.o.pipeline.findPageByUrl(n);
      if (page && (page.availability === "archived" || page.availability === "partial") && page.latestVersionId != null) {
        return { url, state: page.availability === "partial" ? ("partial" as const) : ("cached" as const), pageId: page.publicId };
      }
      const key = this.key(n);
      const job = db.get<{ public_id: string; id: number }>(
        `SELECT d.public_id, d.id FROM jobs j JOIN download_jobs d ON d.id = j.download_job_id
         WHERE j.type IN ('fetch','process') AND j.url_key = ? AND j.state IN ('queued','running','held') ORDER BY j.id DESC LIMIT 1`, [key]);
      if (job) {
        const progress = this.o.pipeline.captureProgress(job.public_id);
        return { url, state: "queued" as const, progress: { downloadJobId: job.public_id, ...(progress ? { percent: progress.percent } : {}) } };
      }
      if (page || offline) return { url, state: "unavailable" as const };
      return { url, state: "live_only" as const };
    });
  }

  // ---- frame state (D-5) ---------------------------------------------------------------------

  /** The last document the listener served to a frame, or undefined. Records a history visit once per document. */
  frameState(userId: number, frameId: string): FrameStateDto | undefined {
    const fs = this.o.archive?.frames.get(frameId);
    if (!fs || !fs.url) return undefined;
    const raw = fs.state;
    const state: FrameStateDto["state"] =
      raw === "ready" ? "cached" : raw === "partial" ? "partial" : raw === "live-only" ? "live_only" : raw === "queued" ? "queued" : "unavailable";
    if (userId > 0 && !fs.interstitial && fs.pageId) {
      this.o.history.recordFromFrame(userId, frameId, fs.seq ?? fs.at, { url: fs.url, title: fs.title ?? "", pageId: fs.pageId });
    }
    return {
      frameId, url: fs.url, ...(fs.title ? { title: fs.title } : {}), state,
      ...(fs.pageId ? { pageId: fs.pageId } : {}), ...(fs.versionId ? { versionId: fs.versionId } : {}),
      ...(fs.reader ? { reader: true } : {}), ...(fs.interstitial ? { interstitial: true } : {}),
      at: new Date(fs.at).toISOString(), seq: fs.seq ?? 0,
    };
  }

  // ---- live check ----------------------------------------------------------------------------

  /** A guarded `HEAD`: can the site be reached, and do its headers let it be framed? Blocked hosts get a 403 `blocked`. */
  async liveCheck(url: string): Promise<LiveCheck> {
    const n = this.normalise(url);
    this.o.connectivity.assertCanReachInternet({ background: false });
    let res: Pick<FetchResult, "status" | "finalUrl" | "headers">;
    try {
      res = await this.o.head(n, AbortSignal.timeout(15_000));
    } catch (e) {
      if (e instanceof FetchError && e.code === "ssrf_blocked") {
        throw new AppError("blocked", "That address points at this network or a private address, so NoConBrain will not contact it.", { reason: e.ssrfReason });
      }
      if (e instanceof AppError) throw e;
      return { url: n, reachable: false, frameable: "unknown", reason: "unreachable" };
    }
    const xfo = (res.headers["x-frame-options"] ?? "").toLowerCase();
    const csp = res.headers["content-security-policy"] ?? "";
    const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp)?.[1]?.trim();
    const appOrigin = new URL(this.o.config.NCB_APP_URL).origin;
    let frameable: LiveCheck["frameable"] = true;
    let reason: LiveCheck["reason"];
    if (xfo.includes("deny") || xfo.includes("sameorigin")) {
      frameable = false;
      reason = "x_frame_options";
    } else if (fa !== undefined && !(fa === "*" || fa.split(/\s+/).includes(appOrigin))) {
      frameable = false;
      reason = "frame_ancestors";
    }
    return { url: n, reachable: res.status < 500, status: res.status, finalUrl: res.finalUrl, frameable, ...(reason ? { reason } : {}) };
  }

  // ---- saving --------------------------------------------------------------------------------

  /** Idempotency-Key support: the same key within 24 hours returns the first answer. */
  remember<T>(key: string | undefined, make: () => T): T {
    if (!key) return make();
    const now = this.o.clock.now();
    for (const [k, v] of this.idempotency) if (now - v.at > 24 * 3600_000) this.idempotency.delete(k);
    const hit = this.idempotency.get(key);
    if (hit) return hit.value as T;
    const value = make();
    this.idempotency.set(key, { at: now, value });
    if (this.idempotency.size > 1000) this.idempotency.delete(this.idempotency.keys().next().value as string);
    return value;
  }

  /**
   * Creates a capture job for one page. The priority comes from the request or from `browser.quickSavePriority` (the "Quick saves"
   * default, P3). It is stored on the download job and, when it differs from the source's own priority, as `page_sources.priority_override`.
   * The page is linked to the built-in Quick saves source, or to `sourceId` when the caller names one.
   * Offline, saving needs `queue: true`; the capture then waits, held, until the connection returns.
   */
  save(input: { url: string; priority?: number; queue?: boolean; requestedBy?: "user" | "search"; sourceId?: number }): { downloadId: string; url: string; state: "queued"; held: boolean; priority: number } {
    const url = this.normalise(input.url);
    const conn = this.connectivityState();
    const offline = conn === "offline";
    if (offline && !input.queue) {
      throw new AppError("offline", this.o.connectivity.forced
        ? "Work offline is on, so the page cannot be saved now. You can queue it and it will be saved when you go back online."
        : "There is no internet connection, so the page cannot be saved now. You can queue it and it will be saved when the connection returns.",
      { canQueue: true, reason: this.o.connectivity.forced ? "forced_offline" : "offline" });
    }
    const priority = (input.priority ?? (this.o.settings.internal("browser") as { quickSavePriority?: number }).quickSavePriority ?? 3) as 1 | 2 | 3 | 4;
    const sourceId = input.sourceId ?? this.o.quickSavesSourceId?.();
    const { downloadId } = this.o.pipeline.captureUrl(url, { priority, requestedBy: input.requestedBy ?? "user", userInitiated: true, sourceId, discoveredVia: "manual", depth: 0 });
    if (offline) this.o.pipeline.holdCapture(downloadId);
    return { downloadId, url, state: "queued", held: offline, priority };
  }
}
