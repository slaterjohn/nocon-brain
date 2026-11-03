import http from "node:http";
import type { Duplex } from "node:stream";
import { systemClock, type Clock } from "@ncb/shared";
import {
  ResourceTable, REWRITER_VERSION, collectUrls, errorPage, interstitialPage, parseReaderPrefs, partialBannerHtml, readerCss, readerPage,
  rewriteCss, sanitizeHtml, sanitizeSvgDocument, BASE_CSS, LINK_STATE_CSS, linkStateStyleBlock, normaliseTerm,
  type LinkResolution, type LinkState, type SanitizeOptions,
} from "@ncb/render";
import { createHash } from "node:crypto";
import { archiveHeaders, originOf } from "./headers.js";
import { AccessBatcher, FrameStateStore } from "./frames.js";
import { BufferAsset, MemoryCaptureStore, type AssetHandle, type CaptureStore, type LinkTarget, type PageAttribution, type VersionRef, type ZimPackageRef } from "./store.js";
import { ArchiveTokenService, type TokenPayload } from "./tokens.js";

/**
 * The archive listener (docs/architecture.md section 8, docs/api.md section 5). A separate `http.Server` with its own
 * small route table: read-only, no sessions, no auth, no API. It never reads the `Cookie` header and never sets one, because
 * cookies cross ports and the archive origin is untrusted. It has no outbound code path: it only reads through `CaptureStore`.
 */

export interface AppRoutes {
  /** Link (in the app) that queues a URL; opened in a new tab so the Human's own session is used. */
  queue(url: string): string;
  save(url: string): string;
  downloadRest(pageId: string): string;
}

export interface ArchiveListenerOptions {
  appUrl: string;
  clock?: Clock;
  tokens?: ArchiveTokenService;
  store?: CaptureStore;
  frames?: FrameStateStore;
  /** User setting `browser.showLinkStates`. Default on. */
  showLinkStates?: () => boolean;
  appRoutes?: AppRoutes;
  touchIntervalMs?: number;
}

export interface ArchiveListener {
  readonly server: http.Server;
  readonly frames: FrameStateStore;
  /** Supplies the pieces that exist only after the database and secret are ready. */
  attach(deps: { tokens?: ArchiveTokenService; store?: CaptureStore; showLinkStates?: () => boolean; appRoutes?: AppRoutes }): void;
  tokens(): ArchiveTokenService | undefined;
  /** Writes pending `last_accessed_at` updates. */
  flush(): Promise<void>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_KEY = /^[0-9a-z]{1,16}$/;
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_URL = 4096;

const SERVED_AS_IS = /^(image\/(?!svg)[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|font\/[a-z0-9.+-]+|application\/(font-woff2?|x-font-[a-z0-9-]+|vnd\.ms-fontobject))$/;
const FONT_TYPE = /^(font\/|application\/(font-|x-font-|vnd\.ms-fontobject))/;

interface Out {
  status: number;
  type?: string;
  body?: string | Buffer;
  stream?: NodeJS.ReadableStream;
  headers?: Record<string, string>;
  popups?: boolean;
  appOrigin?: string;
}

export function createArchiveListener(opts: ArchiveListenerOptions): ArchiveListener {
  const clock = opts.clock ?? systemClock;
  const defaultOrigin = originOf(opts.appUrl);
  const frames = opts.frames ?? new FrameStateStore();
  let tokens = opts.tokens;
  let store: CaptureStore = opts.store ?? new MemoryCaptureStore();
  let showStates = opts.showLinkStates ?? (() => true);
  const appBase = (() => { try { return new URL(opts.appUrl).origin; } catch { return ""; } })();
  // Real app routes (the web app's /save page and the library). Opened in a new tab, so the Human's own session is used.
  let routes: AppRoutes = opts.appRoutes ?? {
    queue: (u) => `${appBase}/save?url=${encodeURIComponent(u)}&queue=1`,
    save: (u) => `${appBase}/save?url=${encodeURIComponent(u)}`,
    downloadRest: (id) => `${appBase}/library?page=${encodeURIComponent(id)}`,
  };
  const batcher = new AccessBatcher((ids, at) => store.touchVersions(ids, at), () => clock.now(), opts.touchIntervalMs);

  const finalise = (req: http.IncomingMessage, res: http.ServerResponse, out: Out) => {
    const headers = archiveHeaders({ appOrigin: out.appOrigin ?? defaultOrigin, popups: out.popups, extra: out.headers });
    for (const k of Object.keys(headers)) if (/^(set-)?cookie$/i.test(k)) delete headers[k]; // never, by construction
    const body = out.body;
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    if (out.type) headers["content-type"] = out.type;
    res.writeHead(out.status, headers);
    if (req.method === "HEAD" || body === undefined && !out.stream) {
      res.end();
      if (out.stream && "destroy" in out.stream) (out.stream as { destroy(): void }).destroy();
      return;
    }
    if (out.stream) {
      out.stream.on("error", () => res.destroy());
      out.stream.pipe(res);
      return;
    }
    res.end(body);
  };

  const text = (status: number, message: string, extra: Partial<Out> = {}): Out => ({
    status, type: "text/plain; charset=utf-8", body: `${message}\n`, ...extra,
  });
  const page = (status: number, title: string, message: string, extra: Partial<Out> = {}): Out => ({
    status, type: "text/html; charset=utf-8", body: errorPage({ status, title, message, appHref: opts.appUrl }), ...extra,
  });
  const notFound = (appOrigin?: string): Out => page(404, "Not found", "That page is not in the archive.", { appOrigin });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return finalise(req, res, text(405, "Method not allowed.", { headers: { allow: "GET, HEAD" } }));
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://archive.invalid");
    } catch {
      return finalise(req, res, text(400, "Bad request."));
    }
    const path = url.pathname;
    if (path === "/healthz" || path === "/__health") return finalise(req, res, text(200, "ok"));
    if (!path.startsWith("/a/")) return finalise(req, res, notFound());

    const rawSegs = path.slice(3).split("/");
    let segs: string[];
    try {
      segs = rawSegs.map((s) => decodeURIComponent(s));
    } catch {
      return finalise(req, res, text(400, "Bad request."));
    }
    const tokenRaw = rawSegs[0] ?? "";
    const verified = tokens?.verify(tokenRaw);
    if (!verified || !verified.ok) {
      return finalise(req, res, page(401, "Link expired", "This archive link has expired or is not valid. Open the page again from NoConBrain.", { appOrigin: defaultOrigin }));
    }
    const ctx: Ctx = { req, token: tokenRaw, payload: verified.payload, url, base: `/a/${tokenRaw}` };
    const out = await route(ctx, segs.slice(1));
    out.appOrigin ??= verified.payload.o;
    finalise(req, res, out);
  };

  interface Ctx {
    req: http.IncomingMessage;
    token: string;
    payload: TokenPayload;
    url: URL;
    base: string;
  }

  const route = async (c: Ctx, s: string[]): Promise<Out> => {
    const [cls, a, b, ...rest] = s;
    switch (cls) {
      case "p": {
        if (!a || !ID.test(a) || (b !== undefined && b !== "reader") || rest.length) return notFound();
        const v = await store.latestVersion(a);
        return v ? (b === "reader" ? serveReader(c, v) : serveDocument(c, v)) : notFound();
      }
      case "v": {
        if (!a || !ID.test(a)) return notFound();
        const v = await store.getVersion(a);
        if (!v) return notFound();
        if (b === undefined) return serveDocument(c, v);
        if (b === "reader" && !rest.length) return serveReader(c, v);
        if (b === "r" && rest.length === 1 && ASSET_KEY.test(rest[0]!)) return serveAsset(c, v, rest[0]!);
        return notFound();
      }
      case "m":
        return s.length === 1 ? serveInterstitial(c) : notFound();
      case "z": {
        if (!a || !ID.test(a)) return notFound();
        return serveZim(c, a, s.length < 3 ? "" : [b, ...rest].join("/"));
      }
      case "_":
        return s.length === 2 && a ? serveStatic(c, a) : notFound();
      default:
        return notFound();
    }
  };

  // --- documents ------------------------------------------------------------------------------------------------------

  const linkTools = async (c: Ctx, version: VersionRef | undefined, baseUrl: string, html: string, extraResource?: SanitizeOptions["resource"], skip?: (abs: string) => boolean) => {
    const found = collectUrls(html, baseUrl);
    const urls = [...new Set(found.links.filter((u) => !skip?.(u)).map((u) => u.replace(/#.*$/, "")))];
    const targets = urls.length ? await store.lookupLinks(urls) : new Map<string, LinkTarget>();
    const offline = store.connectivity() === "offline";
    const table = new ResourceTable();
    if (version) for (const r of await store.listResources(version.versionId)) table.add({ url: r.url, key: r.assetKey, contentType: r.contentType });
    const interstitial = (abs: string) =>
      `${c.base}/m?u=${encodeURIComponent(abs.replace(/#.*$/, ""))}${version ? `&from=${encodeURIComponent(version.versionId)}` : ""}`;
    const link = (abs: string): LinkResolution => {
      const hash = abs.includes("#") ? abs.slice(abs.indexOf("#")) : "";
      const t = targets.get(abs.replace(/#.*$/, ""));
      if (t?.kind === "page") return { href: `${c.base}/p/${encodeURIComponent(t.pageId)}${hash}`, state: t.status === "partial" ? "partial" : "cached" };
      if (t?.kind === "zim") return { href: `${c.base}/z/${encodeURIComponent(t.zimId)}/${t.path.split("/").map(encodeURIComponent).join("/")}${hash}`, state: "cached" };
      if (t?.kind === "queued") return { href: interstitial(abs), state: "queued" };
      const state: LinkState = t?.kind === "unavailable" || offline ? "unavailable" : "live-only";
      return { href: interstitial(abs), state };
    };
    const resource = extraResource ?? (version ? table.resolver((key) => `${c.base}/v/${encodeURIComponent(version.versionId)}/r/${key}`) : () => null);
    return { link, resource, table };
  };

  const framed = (c: Ctx): boolean => {
    const dest = String(c.req.headers["sec-fetch-dest"] ?? "");
    return dest === "iframe" || dest === "document";
  };

  const recordFrame = (c: Ctx, v: VersionRef, title: string, reader = false) => {
    if (!framed(c)) return;
    frames.record(c.payload.f, { versionId: v.versionId, pageId: v.pageId, url: v.url, title, state: v.status, reader, at: clock.now(), userId: Number(c.payload.u) || 0 });
  };

  const serveDocument = async (c: Ctx, v: VersionRef): Promise<Out> => {
    const doc = await store.readDocument(v);
    if (!doc) return notFound();
    const { link, resource } = await linkTools(c, v, doc.baseUrl, doc.html);
    const head = showStates() ? linkStateStyleBlock() : "";
    const banner = v.status === "partial" ? partialBannerHtml(v.missingResources, routes.downloadRest(v.pageId)) : "";
    const footer = attributionFooter(await store.readAttribution?.(v.versionId));
    // `?hl=` marks matches for the shell's find bar (A-18). The same function counts them for /api/archive/versions/{id}/find.
    const term = normaliseTerm(c.url.searchParams.get("hl"));
    const r = sanitizeHtml(doc.html, { baseUrl: doc.baseUrl, link, resource, inject: { head, bodyStart: banner, ...(footer ? { bodyEnd: footer } : {}) }, ...(term ? { highlight: { term } } : {}) });
    batcher.touch(v.versionId);
    // A highlighted copy is the same document with marks added: the address bar does not move for it (A-18).
    if (!term) recordFrame(c, v, r.title);
    return { status: 200, type: "text/html; charset=utf-8", body: r.html };
  };

  const serveReader = async (c: Ctx, v: VersionRef): Promise<Out> => {
    const rd = await store.readReader(v);
    if (!rd) return page(404, "No reader view", "There is no reader view for this page.");
    const { link, resource } = await linkTools(c, v, v.url, rd.html);
    const clean = sanitizeHtml(rd.html, { baseUrl: v.url, link, resource, bodyOnly: true }).html + attributionFooter(await store.readAttribution?.(v.versionId));
    const prefs = parseReaderPrefs(c.url.searchParams);
    batcher.touch(v.versionId);
    recordFrame(c, v, rd.title, true);
    return { status: 200, type: "text/html; charset=utf-8", body: readerPage({ title: rd.title, bodyHtml: clean, prefs, sourceUrl: v.url }) };
  };

  // --- interstitial -----------------------------------------------------------------------------------------------------

  const serveInterstitial = async (c: Ctx): Promise<Out> => {
    const u = c.url.searchParams.get("u") ?? "";
    const from = c.url.searchParams.get("from") ?? "";
    if (!u || u.length > MAX_QUERY_URL) return page(400, "Missing address", "This link has no address to show.", { popups: true });
    const zimTarget = /^zim:\/\/([A-Za-z0-9_-]{1,64})\/(.*)$/.exec(u);
    if (zimTarget) {
      // A link inside a knowledge package whose target the package does not hold (task Z-04).
      const pkg = store.zimPackage ? await store.zimPackage(zimTarget[1]!) : null;
      let where = zimTarget[2]!;
      try { where = decodeURIComponent(where); } catch { /* shown as given */ }
      const name = pkg ? `“${pkg.title}”` : "this package";
      return page(200, "Not in this package", `This link leads to “${where}”, which is not in ${name}. Packages are often cut-down copies, so some links lead nowhere.`, { popups: true });
    }
    const offline = store.connectivity() === "offline";
    let isHttp = false;
    try {
      const p = new URL(u);
      isHttp = p.protocol === "http:" || p.protocol === "https:";
    } catch { /* shown as text */ }
    let state: LinkState = "unsupported";
    if (isHttp) {
      const t = (await store.lookupLinks([u])).get(u);
      if (t?.kind === "page") return { status: 302, headers: { location: `${c.base}/p/${encodeURIComponent(t.pageId)}` }, body: "", type: "text/plain; charset=utf-8" };
      if (t?.kind === "zim") return { status: 302, headers: { location: `${c.base}/z/${encodeURIComponent(t.zimId)}/${t.path.split("/").map(encodeURIComponent).join("/")}` }, body: "", type: "text/plain; charset=utf-8" };
      state = t?.kind === "queued" ? "queued" : t?.kind === "unavailable" || offline ? "unavailable" : "live-only";
    }
    // The address bar follows the frame (D-5): an address that is not in the archive is still where the Human is.
    if (framed(c)) frames.record(c.payload.f, { url: u, title: u, state, interstitial: true, at: clock.now() });
    return {
      status: 200, type: "text/html; charset=utf-8", popups: true,
      body: interstitialPage({
        url: u, state, offline,
        queueHref: isHttp && state !== "queued" ? routes.queue(u) : undefined,
        saveHref: isHttp ? routes.save(u) : undefined,
        backHref: ID.test(from) ? `${c.base}/v/${from}` : undefined,
      }),
    };
  };

  // --- sub-resources ------------------------------------------------------------------------------------------------------

  const parseRange = (header: string | undefined, size: number): { start: number; end: number } | "invalid" | null => {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return null; // multi-range and other units: ignore, serve everything
    let start: number;
    let end: number;
    if (m[1] === "" && m[2] === "") return "invalid";
    if (m[1] === "") {
      const n = Number(m[2]);
      if (n === 0) return "invalid";
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) return "invalid";
    return { start, end };
  };

  const serveBytes = (c: Ctx, handle: AssetHandle, contentType: string, etagOverride?: string): Out => {
    const type = contentType.split(";")[0]!.trim().toLowerCase();
    const etag = etagOverride ?? `"${handle.sha256.slice(0, 32)}-${REWRITER_VERSION}"`;
    const headers: Record<string, string> = {
      "cache-control": "private, max-age=31536000, immutable",
      etag,
      "accept-ranges": "bytes",
    };
    let sendType = type;
    if (FONT_TYPE.test(type)) headers["access-control-allow-origin"] = "*"; // fonts are fetched with CORS from an opaque origin
    if (!SERVED_AS_IS.test(type)) {
      // Anything that could be active content (html, scripts, xml, pdf) is only offered as a download.
      sendType = "application/octet-stream";
      headers["content-disposition"] = "attachment";
    }
    if (c.req.headers["if-none-match"] === etag) return { status: 304, headers };
    const range = parseRange(c.req.headers.range as string | undefined, handle.size);
    if (range === "invalid") return { status: 416, headers: { ...headers, "content-range": `bytes */${handle.size}` }, body: "" };
    if (range) {
      headers["content-range"] = `bytes ${range.start}-${range.end}/${handle.size}`;
      headers["content-length"] = String(range.end - range.start + 1);
      return { status: 206, type: sendType, headers, stream: handle.open(range) };
    }
    headers["content-length"] = String(handle.size);
    return { status: 200, type: sendType, headers, stream: handle.open() };
  };

  const serveAsset = async (c: Ctx, v: VersionRef, key: string): Promise<Out> => {
    const asset = await store.getAsset(v.versionId, key);
    if (!asset) return notFound();
    const type = asset.contentType.split(";")[0]!.trim().toLowerCase();
    if (type === "text/css" || type === "image/svg+xml") {
      if (asset.size > MAX_REWRITE_BYTES) return text(413, "Too large.");
      const src = (await asset.readAll(MAX_REWRITE_BYTES)).toString("utf8");
      const { resource, table } = await linkTools(c, v, v.url, "");
      const origin = table.originalUrl(key) ?? v.url;
      const headers = { "cache-control": "private, max-age=31536000, immutable" };
      if (type === "text/css") {
        return { status: 200, type: "text/css; charset=utf-8", headers, body: rewriteCss(src, { baseUrl: origin, resource }) };
      }
      const svg = sanitizeSvgDocument(src, { baseUrl: origin, resource });
      return svg === null ? notFound() : { status: 200, type: "image/svg+xml; charset=utf-8", headers, body: svg };
    }
    return serveBytes(c, asset, asset.contentType);
  };

  // --- ZIM entries ------------------------------------------------------------------------------------------------------------

  /**
   * ZIM entries (docs/api.md section 5, task Z-04). Every in-package reference is resolved against a virtual origin `https://zim.invalid/`
   * whose path is the entry path, which is what a ZIM's own relative links assume (a `..` stops at the root, as in a real ZIM). Packages
   * written before libzim 7 hide an `A/` prefix on articles, so those resolve against `/A/<path>` and the prefix is removed again.
   */
  const ZIM_ORIGIN = "https://zim.invalid";
  const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const zimHref = (c: Ctx, zimId: string, p: string, hash = "") => `${c.base}/z/${encodeURIComponent(zimId)}/${encPath(p)}${hash}`;
  const zimPseudoUrl = (zimId: string, p: string) => `zim://${zimId}/${encPath(p)}`;

  const serveZim = async (c: Ctx, zimId: string, rawPath: string): Promise<Out> => {
    const pkg = store.zimPackage ? await store.zimPackage(zimId) : null;
    if (!pkg || !store.getZimEntry) return page(404, "Not in this knowledge package", "That package is not available. It may have been removed, or its file may be missing.");
    if (rawPath === "") {
      return pkg.mainPath ? { status: 302, headers: { location: zimHref(c, zimId, pkg.mainPath) }, body: "", type: "text/plain; charset=utf-8" } : page(404, "No main page", `“${pkg.title}” has no main page. Search it or browse its entries instead.`);
    }
    const entry = await store.getZimEntry(zimId, rawPath);
    if (!entry) return page(404, "Not in this knowledge package", `That entry is not in “${pkg.title}”. Packages are cut-down copies, so some links lead nowhere.`);
    if (entry.redirectTo !== undefined) return { status: 302, headers: { location: zimHref(c, zimId, entry.redirectTo) }, body: "", type: "text/plain; charset=utf-8" };
    const type = entry.contentType.split(";")[0]!.trim().toLowerCase();
    const uuid = entry.uuid ?? pkg.uuid;
    const etagBase = `"zim-${createHash("sha1").update(`${uuid}\0${rawPath}`).digest("hex").slice(0, 24)}-${REWRITER_VERSION}`;
    const oldScheme = !pkg.newNamespaceScheme;
    const baseUrl = `${ZIM_ORIGIN}/${oldScheme ? "A/" : ""}${encPath(rawPath)}`;
    const inZim = (abs: string) => abs.startsWith(`${ZIM_ORIGIN}/`);
    /** The package path an absolute virtual URL stands for (no query or fragment), in the form libzim wants. */
    const toPath = (abs: string): string => {
      let p = decodeURIComponent(abs.slice(ZIM_ORIGIN.length + 1).replace(/[?#].*$/, ""));
      if (oldScheme && p.startsWith("A/")) p = p.slice(2);
      return p;
    };
    const safePath = (abs: string): string | null => {
      try { return toPath(abs); } catch { return null; }
    };
    const resource: SanitizeOptions["resource"] = (abs) => (inZim(abs) && safePath(abs) !== null ? zimHref(c, zimId, safePath(abs)!) : null);

    if (type === "text/html" || type === "application/xhtml+xml") {
      const html = entry.body.toString("utf8");
      const found = collectUrls(html, baseUrl);
      const wanted = [...new Set([...found.links, ...found.resources].filter(inZim).map(safePath).filter((p): p is string => !!p))].slice(0, 3000);
      const exists = store.zimExists ? await store.zimExists(zimId, wanted) : new Set(wanted);
      const { link: outside } = await linkTools(c, undefined, baseUrl, html, undefined, inZim);
      const missingHref = (p: string) => `${c.base}/m?u=${encodeURIComponent(zimPseudoUrl(zimId, p))}`;
      const r = sanitizeHtml(html, {
        baseUrl,
        resource: (abs) => {
          const p = inZim(abs) ? safePath(abs) : null;
          return p !== null && exists.has(p) ? zimHref(c, zimId, p) : null;
        },
        link: (abs) => {
          if (!inZim(abs)) return outside(abs);
          const p = safePath(abs);
          const hash = abs.includes("#") ? abs.slice(abs.indexOf("#")) : "";
          if (p === null || p === "") return { href: missingHref(rawPath), state: "unavailable" };
          return exists.has(p) ? { href: zimHref(c, zimId, p, hash), state: "cached" } : { href: missingHref(p), state: "unavailable" };
        },
        inject: { head: showStates() ? linkStateStyleBlock() : "", bodyStart: zimBar(pkg) },
      });
      const etag = `${etagBase}-${createHash("sha1").update(r.html).digest("hex").slice(0, 16)}"`;
      // Link states depend on what is archived right now, so the document is revalidated each time rather than cached.
      const headers = { etag, "cache-control": "private, no-cache" };
      if (c.req.headers["if-none-match"] === etag) return { status: 304, headers };
      if (framed(c)) frames.record(c.payload.f, { url: pkg.webUrl?.(rawPath) ?? zimPseudoUrl(zimId, rawPath), title: r.title || rawPath, state: "zim", zimId, zimPath: rawPath, at: clock.now(), userId: Number(c.payload.u) || 0 });
      return { status: 200, type: "text/html; charset=utf-8", body: r.html, headers };
    }

    const etag = `${etagBase}"`;
    const immutable = { etag, "cache-control": "private, max-age=31536000, immutable" };
    if (c.req.headers["if-none-match"] === etag) return { status: 304, headers: immutable };
    if (type === "text/css") {
      if (entry.body.length > MAX_REWRITE_BYTES) return text(413, "Too large.");
      return { status: 200, type: "text/css; charset=utf-8", headers: immutable, body: rewriteCss(entry.body.toString("utf8"), { baseUrl, resource }) };
    }
    if (type === "image/svg+xml") {
      if (entry.body.length > MAX_REWRITE_BYTES) return text(413, "Too large.");
      const svg = sanitizeSvgDocument(entry.body.toString("utf8"), { baseUrl, resource });
      return svg === null ? notFound() : { status: 200, type: "image/svg+xml; charset=utf-8", headers: immutable, body: svg };
    }
    return serveBytes(c, new BufferAsset(entry.contentType, entry.body), entry.contentType, etag);
  };

  /**
   * The credit CC BY-SA asks for, at the foot of a page that carries one (task Z-08): the licence and where the text came from, the article and
   * its history, the revision, the date, and the author and licence of each image. Static markup; every link opens in a new tab.
   */
  const attributionFooter = (a: PageAttribution | null | undefined): string => {
    if (!a) return "";
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const http = (u: string | null) => (u && /^https?:\/\//i.test(u) ? esc(u) : null);
    const link = (u: string | null, label: string) => (http(u) ? `<a href="${http(u)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label));
    const when = new Date(a.retrievedAt).toISOString().slice(0, 10);
    const lic = a.licenseName ? link(a.licenseUrl, a.licenseName) : "its licence";
    const parts = [
      `Text from Wikipedia, licensed under ${lic}.`,
      a.sourceUrl ? `Article: ${link(a.sourceUrl, a.sourceUrl)}.` : "",
      a.historyUrl ? `Authors: ${link(a.historyUrl, "see the article history")}.` : "",
      `Archived on ${when}${a.revisionId ? `, revision ${esc(a.revisionId)}` : ""}.`,
    ].filter(Boolean).join(" ");
    const images = a.images.length
      ? `<details style="margin-top:6px"><summary>Image credits (${a.images.length})</summary><ul style="margin:4px 0 0 18px;padding:0">${a.images.map((i) =>
        `<li>${i.sourcePageUrl ? link(i.sourcePageUrl, i.file ?? "Image") : esc(i.file ?? "Image")}${i.author ? ` by ${esc(i.author)}` : ""}${i.licenseName ? `, ${i.licenseUrl ? link(i.licenseUrl, i.licenseName) : esc(i.licenseName)}` : ""}</li>`).join("")}</ul></details>`
      : "";
    return `<footer data-ncb-attribution style="font:12px/1.5 system-ui,sans-serif;margin:24px 0 0;padding:10px 12px;background:#f4f4f4;color:#333;border-top:1px solid #ddd">${parts}${images}</footer>`;
  };

  /** A thin bar above a package's pages: where the text comes from and under which licence (CC BY-SA asks for it). */
  const zimBar = (pkg: ZimPackageRef): string => {
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const lic = pkg.licenseName ? ` Licence: ${esc(pkg.licenseName)}.` : "";
    return `<div data-ncb-zim-bar style="font:12px/1.4 system-ui,sans-serif;padding:4px 10px;background:#f4f4f4;color:#333;border-bottom:1px solid #ddd">From the offline package <b>${esc(pkg.title)}</b>.${lic}</div>`;
  };

  // --- static listener assets ------------------------------------------------------------------------------------------------------------

  const serveStatic = (c: Ctx, name: string): Out => {
    const headers = { "cache-control": "private, max-age=3600" };
    if (name === "ui.css") return { status: 200, type: "text/css; charset=utf-8", headers, body: BASE_CSS };
    if (name === "links.css") return { status: 200, type: "text/css; charset=utf-8", headers, body: LINK_STATE_CSS };
    if (name === "reader.css") return { status: 200, type: "text/css; charset=utf-8", headers, body: readerCss(parseReaderPrefs(c.url.searchParams)) };
    return notFound();
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) finalise(req, res, page(500, "Something went wrong", "The archive could not show this page."));
      else res.destroy();
    });
  });
  // A malformed request never reaches the handler; answer it with the same header set instead of Node's bare 400.
  server.on("clientError", (err: Error & { code?: string }, socket: Duplex) => {
    if (!socket.writable) return;
    const status = err.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request";
    const h = archiveHeaders({ appOrigin: defaultOrigin });
    const lines = Object.entries({ ...h, "content-type": "text/plain; charset=utf-8", "content-length": "0", connection: "close" }).map(([k, v]) => `${k}: ${v}`);
    socket.end(`HTTP/1.1 ${status}\r\n${lines.join("\r\n")}\r\n\r\n`);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.on("close", () => void batcher.flush());

  return {
    server,
    frames,
    attach(deps) {
      if (deps.tokens) tokens = deps.tokens;
      if (deps.store) store = deps.store;
      if (deps.showLinkStates) showStates = deps.showLinkStates;
      if (deps.appRoutes) routes = deps.appRoutes;
    },
    tokens: () => tokens,
    flush: () => batcher.flush(),
  };
}

/** Compatibility wrapper: the bare server (no tokens, so every `/a/...` request answers 401). */
export function createArchiveServer(opts: ArchiveListenerOptions): http.Server {
  return createArchiveListener(opts).server;
}
