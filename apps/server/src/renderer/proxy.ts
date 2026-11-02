import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { isSsrfError, type SsrfGuard } from "@ncb/fetch";

/**
 * The guarded forward proxy (task C-16, decision D-4). The renderer's browser reaches the web only through this
 * listener: it sits on an internal-only network, so there is no other route. Chromium does its own DNS, so the check
 * has to happen here, at the boundary.
 *
 * Every request and every CONNECT goes through the same SSRF guard as the server's own fetcher: scheme, credentials,
 * port policy, IP literals in every spelling, and a validating `lookup` that is the only way a hostname becomes an
 * address (so a DNS answer cannot change between the check and the connection). The browser follows redirects itself,
 * so each hop arrives here as a new request and is checked again. HTTPS passes through `CONNECT` tunnels whose
 * content is not inspected; what the browser sends and receives inside is bounded by the renderer's own budget and by
 * `maxTunnelBytes` here.
 */

export interface ProxyPoliteness {
  /** Connections to one host at the same time. A browser opens several for one page. Default 6. */
  maxConcurrentPerHost: number;
  /** Minimum gap between two new connections or requests to the same host. Default 50 ms. */
  minIntervalMs: number;
  /** How long a request may wait for a free slot on its host before it is refused with 503. Default 15 s. */
  maxWaitMs: number;
}

export interface ProxyOptions {
  guard: SsrfGuard;
  /** When set, clients must send `Proxy-Authorization: Basic base64("renderer:<token>")`. */
  token?: string;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  politeness?: Partial<ProxyPoliteness>;
  /** Connections the proxy keeps open in total. Default 64. */
  maxConnections?: number;
  /** Bytes through one tunnel or one plain response before it is cut. Default 100 MiB. */
  maxTunnelBytes?: number;
  /** An idle tunnel is closed after this long. Default 60 s. */
  idleTimeoutMs?: number;
  /** True while the server works offline: nothing leaves. */
  isOffline?: () => boolean;
  onEvent?: (e: ProxyEvent) => void;
}

export type ProxyEvent =
  | { type: "blocked"; target: string; reason: string; method: string }
  | { type: "tunnel" | "request"; host: string; port: number };

export interface ProxyStats {
  requests: number;
  tunnels: number;
  blocked: number;
  unauthorised: number;
  /** Connections actually opened to the outside. */
  upstream: number;
  blockedByReason: Record<string, number>;
  open: number;
}

const DEFAULT_POLITENESS: ProxyPoliteness = { maxConcurrentPerHost: 6, minIntervalMs: 50, maxWaitMs: 15_000 };

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Per-host politeness: a bounded number of connections and a minimum gap between them. */
export class HostLimiter {
  private readonly state = new Map<string, { active: number; nextAt: number; waiters: (() => void)[] }>();
  constructor(private readonly p: ProxyPoliteness) {}

  /** Resolves with a release function, or rejects after `maxWaitMs`. */
  async acquire(host: string): Promise<() => void> {
    let s = this.state.get(host);
    if (!s) this.state.set(host, (s = { active: 0, nextAt: 0, waiters: [] }));
    const deadline = Date.now() + this.p.maxWaitMs;
    while (s.active >= this.p.maxConcurrentPerHost) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("host busy");
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("host busy")), left);
        s!.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
    s.active++;
    const gap = s.nextAt - Date.now();
    s.nextAt = Math.max(s.nextAt, Date.now()) + this.p.minIntervalMs;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const cur = this.state.get(host);
      if (!cur) return;
      cur.active--;
      cur.waiters.shift()?.();
      if (cur.active <= 0 && cur.waiters.length === 0) this.state.delete(host);
    };
  }
}

function basicToken(header: string | undefined): string | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return i < 0 ? null : decoded.slice(i + 1);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class GuardedProxy {
  readonly server: http.Server;
  private readonly guard: SsrfGuard;
  private readonly limiter: HostLimiter;
  private readonly sockets = new Set<Duplex>();
  private readonly o: Required<Pick<ProxyOptions, "maxConnections" | "maxTunnelBytes" | "idleTimeoutMs">> & ProxyOptions;
  readonly stats: ProxyStats = { requests: 0, tunnels: 0, blocked: 0, unauthorised: 0, upstream: 0, blockedByReason: {}, open: 0 };

  constructor(opts: ProxyOptions) {
    this.o = { maxConnections: 64, maxTunnelBytes: 100 * 1024 * 1024, idleTimeoutMs: 60_000, ...opts };
    this.guard = opts.guard;
    this.limiter = new HostLimiter({ ...DEFAULT_POLITENESS, ...opts.politeness });
    this.server = http.createServer({ headersTimeout: 15_000, requestTimeout: 0, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024 }, (req, res) => void this.handleRequest(req, res));
    this.server.on("connect", (req, socket, head) => void this.handleConnect(req, socket as net.Socket, head));
    this.server.on("clientError", (_e, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      this.stats.open = this.sockets.size;
      s.on("close", () => { this.sockets.delete(s); this.stats.open = this.sockets.size; });
    });
  }

  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.o.port ?? 3128, this.o.host ?? "0.0.0.0", () => resolve());
    });
    const a = this.server.address();
    return { host: this.o.host ?? "0.0.0.0", port: typeof a === "object" && a ? a.port : (this.o.port ?? 3128) };
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  // ---- checks --------------------------------------------------------------------------------

  private authorised(header: string | undefined): boolean {
    if (!this.o.token) return true;
    const t = basicToken(header);
    return t !== null && safeEqual(t, this.o.token);
  }

  private block(method: string, target: string, reason: string): void {
    this.stats.blocked++;
    this.stats.blockedByReason[reason] = (this.stats.blockedByReason[reason] ?? 0) + 1;
    this.o.onEvent?.({ type: "blocked", target: target.slice(0, 200), reason, method });
  }

  private refuseResponse(res: http.ServerResponse, status: number, message: string, extra: http.OutgoingHttpHeaders = {}): void {
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close", "cache-control": "no-store", ...extra });
    res.end(message + "\n");
  }

  private refuseSocket(socket: net.Socket, status: number, text: string, extra = ""): void {
    if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
    else socket.destroy();
  }

  // ---- plain HTTP ----------------------------------------------------------------------------

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.stats.requests++;
    if (!this.authorised(req.headers["proxy-authorization"])) {
      this.stats.unauthorised++;
      return this.refuseResponse(res, 407, "Proxy authentication required", { "proxy-authenticate": 'Basic realm="noconbrain-renderer"' });
    }
    if (this.o.isOffline?.()) return this.refuseResponse(res, 503, "The archive is working offline.");
    if (this.sockets.size > this.o.maxConnections) return this.refuseResponse(res, 503, "Too many connections.");
    // A proxy request uses the absolute form. Anything else would be a request to this server itself.
    let url: URL;
    try {
      if (!/^http:\/\//i.test(req.url ?? "")) throw new Error("not absolute http");
      url = this.guard.checkUrl(req.url!);
    } catch (e) {
      const s = isSsrfError(e);
      this.block(req.method ?? "GET", req.url ?? "", s?.reason ?? "bad_request");
      return this.refuseResponse(res, s ? 403 : 400, s ? `Blocked: ${s.reason}` : "Only absolute http:// requests are proxied. Use CONNECT for https.");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || 80);
    let release: (() => void) | undefined;
    try {
      release = await this.limiter.acquire(`${host}:${port}`);
    } catch {
      return this.refuseResponse(res, 503, "That site is busy; try again shortly.", { "retry-after": "2" });
    }
    this.o.onEvent?.({ type: "request", host, port });
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
    headers.host = url.host;
    let sent = 0;
    this.stats.upstream++;
    const up = http.request(
      { host, port, method: req.method, path: url.pathname + url.search, headers, lookup: this.guard.lookup as net.LookupFunction, timeout: this.o.idleTimeoutMs, setHost: false },
      (ur) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v;
        res.writeHead(ur.statusCode ?? 502, ur.statusMessage, out);
        ur.on("data", (c: Buffer) => {
          sent += c.length;
          if (sent > this.o.maxTunnelBytes) { ur.destroy(); res.destroy(); }
        });
        ur.pipe(res);
      },
    );
    const done = () => release?.();
    res.on("close", () => { done(); up.destroy(); });
    up.on("timeout", () => up.destroy(new Error("upstream timeout")));
    up.on("error", (e) => {
      done();
      const s = isSsrfError(e);
      if (s) {
        this.block(req.method ?? "GET", url.href, s.reason);
        return this.refuseResponse(res, 403, `Blocked: ${s.reason}`);
      }
      this.refuseResponse(res, 502, "Could not reach that site.");
    });
    req.pipe(up);
  }

  // ---- CONNECT -------------------------------------------------------------------------------

  private async handleConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    this.stats.tunnels++;
    client.on("error", () => client.destroy());
    if (!this.authorised(req.headers["proxy-authorization"])) {
      this.stats.unauthorised++;
      return this.refuseSocket(client, 407, "Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="noconbrain-renderer"\r\n');
    }
    if (this.o.isOffline?.()) return this.refuseSocket(client, 503, "Service Unavailable");
    if (this.sockets.size > this.o.maxConnections) return this.refuseSocket(client, 503, "Service Unavailable");
    let url: URL;
    try {
      // `host:port` from the request line, parsed with the same URL rules the fetcher uses (so 2130706433 or 0x7f.1 become 127.0.0.1).
      const target = req.url ?? "";
      if (!/^(\[[0-9a-fA-F:.]+\]|[^\s/@?#\\\[\]]+):\d{1,5}$/.test(target)) throw new Error("bad CONNECT target");
      url = this.guard.checkUrl(`https://${target}/`);
    } catch (e) {
      const s = isSsrfError(e);
      this.block("CONNECT", req.url ?? "", s?.reason ?? "bad_request");
      return this.refuseSocket(client, s ? 403 : 400, s ? "Forbidden" : "Bad Request");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || 443);
    let release: (() => void) | undefined;
    try {
      release = await this.limiter.acquire(`${host}:${port}`);
    } catch {
      return this.refuseSocket(client, 503, "Service Unavailable", "Retry-After: 2\r\n");
    }
    if (client.destroyed) return release();
    this.o.onEvent?.({ type: "tunnel", host, port });
    this.stats.upstream++;
    let bytes = 0;
    const upstream = net.connect({ host, port, lookup: this.guard.lookup as net.LookupFunction, timeout: 15_000 });
    let connected = false;
    const finish = () => { release?.(); client.destroy(); upstream.destroy(); };
    upstream.once("connect", () => {
      connected = true;
      upstream.setTimeout(this.o.idleTimeoutMs);
      client.setTimeout(this.o.idleTimeoutMs);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      const count = (c: Buffer) => { bytes += c.length; if (bytes > this.o.maxTunnelBytes) finish(); };
      upstream.on("data", count);
      client.on("data", count);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("timeout", finish);
    client.on("timeout", finish);
    upstream.on("error", (e) => {
      const s = isSsrfError(e);
      if (s) this.block("CONNECT", req.url ?? "", s.reason);
      if (!connected) {
        // Nothing was promised yet, so the browser gets a real status. The socket closes once it has been written.
        this.refuseSocket(client, s ? 403 : 502, s ? "Forbidden" : "Bad Gateway");
        release?.();
        upstream.destroy();
        return;
      }
      finish();
    });
    upstream.on("close", finish);
    client.on("close", finish);
  }
}
