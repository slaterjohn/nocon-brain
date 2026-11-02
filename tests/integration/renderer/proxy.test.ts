import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSsrfGuard, type Resolver } from "../../../packages/fetch/src";
import { GuardedProxy } from "../../../apps/server/src/renderer/proxy";
import { getJson, startFixtures, type Fixtures } from "../fetch/helpers";

const TOKEN = "t".repeat(32);
const auth = `Basic ${Buffer.from(`renderer:${TOKEN}`).toString("base64")}`;
// Names that would need real DNS in the wild are pointed at addresses the guard must refuse.
const resolver: Resolver = async (host) => {
  if (host === "public.example") return [{ address: "93.184.216.34", family: 4 }];
  if (host === "internal.example") return [{ address: "10.1.2.3", family: 4 }];
  return [{ address: "127.0.0.1", family: 4 }];
};

let fx: Fixtures;
let proxy: GuardedProxy;
let proxyPort: number;
let bait: string;
let article: string;
let edge: string;
let targets: Record<string, { url: string; hitsCanary?: boolean }>;
const canary = async () => (await getJson<{ hits: number }>(`${bait}/__canary`)).hits;

beforeAll(async () => {
  fx = await startFixtures({ edgeSlowMs: 150 });
  bait = fx.urls.ssrfBait!;
  article = fx.urls.article!;
  edge = fx.urls.edge!;
  targets = await getJson(`${bait}/__targets`);
  // The article and edge fixtures are the only private origins that may be reached; the bait origin is not.
  const allow = [new URL(article), new URL(edge)].map((u) => `127.0.0.1:${u.port}`).join(",");
  proxy = new GuardedProxy({
    guard: createSsrfGuard({ allow, resolver }), token: TOKEN, host: "127.0.0.1", port: 0,
    politeness: { maxConcurrentPerHost: 2, minIntervalMs: 120, maxWaitMs: 5000 },
  });
  proxyPort = (await proxy.listen()).port;
});
beforeEach(async () => {
  await fetch(`${bait}/__canary/reset`);
  await fetch(`${edge}/__log/reset`);
});
afterAll(async () => {
  await proxy.close();
  await fx.close();
});

interface Answer {
  status: number;
  body: string;
}

/** A plain-HTTP request in proxy (absolute) form. */
function viaProxy(url: string, o: { auth?: string | null; path?: string; method?: string } = {}): Promise<Answer & { headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: (() => { try { return new URL(url).host; } catch { return "x"; } })() };
    if (o.auth !== null) headers["proxy-authorization"] = o.auth ?? auth;
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: o.method ?? "GET", path: o.path ?? url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** CONNECT host:port. Returns the status line the proxy answered with and, when it is 200, the open socket. */
function connect(target: string, o: { auth?: string | null } = {}): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${o.auth === null ? "" : `Proxy-Authorization: ${o.auth ?? auth}\r\n`}\r\n`);
    });
    let buf = "";
    socket.on("data", function onData(c) {
      buf += c.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ status: Number(/^HTTP\/1\.\d (\d{3})/.exec(buf)?.[1] ?? 0), socket });
    });
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: Number(/^HTTP\/1\.\d (\d{3})/.exec(buf)?.[1] ?? 0), socket }));
  });
}

const hostPort = (u: string): string | null => {
  try {
    const x = new URL(u);
    if (x.protocol !== "http:" && x.protocol !== "https:") return null;
    return `${x.hostname}:${x.port || (x.protocol === "https:" ? 443 : 80)}`;
  } catch {
    return null;
  }
};

describe("C-16 guarded forward proxy: SSRF", () => {
  it("refuses every ssrfBait target as a plain request, and the canary stays 0", async () => {
    for (const [name, t] of Object.entries(targets)) {
      const r = await viaProxy(t.url);
      expect([400, 403], `${name} -> ${r.status} ${r.body}`).toContain(r.status);
      // http:// targets are an SSRF refusal; other schemes are not proxy requests at all.
      if (t.url.startsWith("http:")) expect(r.status, name).toBe(403);
    }
    expect(await canary()).toBe(0);
  });

  it("refuses CONNECT to every ssrfBait target, and the canary stays 0", async () => {
    for (const [name, t] of Object.entries(targets)) {
      const hp = hostPort(t.url);
      if (!hp) continue;
      const { status, socket } = await connect(hp);
      socket.destroy();
      expect(status, `${name} (${hp})`).toBe(403);
    }
    expect(await canary()).toBe(0);
  });

  it("refuses CONNECT to private, loopback, link-local and metadata addresses", async () => {
    for (const hp of ["10.0.0.1:443", "172.16.5.5:443", "192.168.1.1:443", "169.254.169.254:80", "169.254.169.254:443", "127.0.0.1:443", `127.0.0.1:${new URL(bait).port}`, "[::1]:443", "[fe80::1]:443", "[::ffff:10.0.0.1]:443", "0.0.0.0:443", "100.64.0.1:443", "2130706433:443", "0x7f.1:443", "localhost:443"]) {
      const { status, socket } = await connect(hp);
      socket.destroy();
      expect(status, hp).toBe(403);
    }
    expect(await canary()).toBe(0);
  });

  it("refuses a hostname that resolves to a private address (the lookup is the check, not the name)", async () => {
    const { status, socket } = await connect("internal.example:443");
    socket.destroy();
    expect(status).toBe(403);
    const plain = await viaProxy("http://internal.example/");
    expect(plain.status).toBe(403);
    // The stub resolver sends every other name to loopback, which is refused too.
    expect((await viaProxy(`http://anything.example:${new URL(bait).port}/canary`)).status).toBe(403);
    expect(await canary()).toBe(0);
    expect(proxy.stats.blockedByReason.resolved_address ?? 0).toBeGreaterThan(0);
  });

  it("refuses ports on the internal-services list even for a public name, and malformed CONNECT targets", async () => {
    for (const hp of ["public.example:22", "public.example:6379", "public.example:2375"]) {
      const { status, socket } = await connect(hp);
      socket.destroy();
      expect(status, hp).toBe(403);
    }
    for (const bad of ["no-port", "host:99999999", "user@host:443", "host:443/path", "[::1:443"]) {
      const { status, socket } = await connect(bad);
      socket.destroy();
      expect([400, 403], bad).toContain(status);
    }
  });

  it("checks every hop of a redirect: the browser follows a Location back through the proxy and it is refused", async () => {
    // The article fixture is allowed; its redirect points at the bait canary, which is not.
    const first = await viaProxy(`${edge}/redirect/to?url=${encodeURIComponent(targets.loopback!.url)}`);
    expect([301, 302, 303, 307, 308]).toContain(first.status);
    const loc = first.headers.location!;
    expect(loc).toBe(targets.loopback!.url);
    const second = await viaProxy(loc);
    expect(second.status).toBe(403);
    expect(await canary()).toBe(0);
  });

  it("only proxies absolute http:// requests", async () => {
    expect((await viaProxy("/health", { path: "/health" })).status).toBe(400);
    expect((await viaProxy("https://example.org/", { path: "https://example.org/" })).status).toBe(400);
    expect((await viaProxy("ftp://x/", { path: "ftp://x/" })).status).toBe(400);
  });
});

describe("C-16 guarded forward proxy: authentication and routing", () => {
  it("answers 407 without the right credentials, for requests and for CONNECT", async () => {
    expect((await viaProxy(`${article}/astronomy`, { auth: null })).status).toBe(407);
    expect((await viaProxy(`${article}/astronomy`, { auth: `Basic ${Buffer.from("renderer:wrong").toString("base64")}` })).status).toBe(407);
    const c = await connect(hostPort(article)!, { auth: null });
    c.socket.destroy();
    expect(c.status).toBe(407);
    expect(proxy.stats.unauthorised).toBeGreaterThanOrEqual(3);
  });

  it("passes an allowed plain request through", async () => {
    const r = await viaProxy(`${article}/astronomy`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("Astronomy");
    expect(r.headers["proxy-authorization"]).toBeUndefined();
  });

  it("opens a CONNECT tunnel to an allowed host and carries bytes both ways", async () => {
    const { status, socket } = await connect(hostPort(article)!);
    expect(status).toBe(200);
    const answer = await new Promise<string>((resolve) => {
      let s = "";
      socket.on("data", (c) => (s += c.toString()));
      socket.on("close", () => resolve(s));
      socket.write(`GET /astronomy HTTP/1.1\r\nHost: ${new URL(article).host}\r\nConnection: close\r\n\r\n`);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
    expect(answer).toContain("Astronomy");
  });
});

describe("C-16 guarded forward proxy: per-host politeness", () => {
  it("never has more than the configured connections open to one host", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => viaProxy(`${edge}/slow?i=${i}`)));
    const log = await getJson<{ maxInFlight: number; total: number }>(`${edge}/__log`);
    expect(log.total).toBeGreaterThanOrEqual(6);
    expect(log.maxInFlight).toBeLessThanOrEqual(2);
  });

  it("spaces new requests to the same host", async () => {
    await fetch(`${edge}/__log/reset`);
    await Promise.all(Array.from({ length: 4 }, (_, i) => viaProxy(`${edge}/final?i=${i}`)));
    const log = await getJson<{ entries: { t: number }[] }>(`${edge}/__log`);
    const ts = log.entries.map((e) => e.t).sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(90);
  });
});

describe("C-16 guarded forward proxy: offline and limits", () => {
  it("makes no outbound connection while the server works offline", async () => {
    let offline = true;
    const p = new GuardedProxy({ guard: createSsrfGuard({ allow: `127.0.0.1:${new URL(article).port}` }), host: "127.0.0.1", port: 0, isOffline: () => offline });
    const port = (await p.listen()).port;
    try {
      const status = await new Promise<number>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: `${article}/astronomy`, headers: { host: new URL(article).host } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on("error", reject);
      });
      expect(status).toBe(503);
      expect(p.stats.upstream).toBe(0);
      offline = false;
      const ok = await new Promise<number>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: `${article}/astronomy`, headers: { host: new URL(article).host } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on("error", reject);
      });
      expect(ok).toBe(200);
    } finally {
      await p.close();
    }
  });

  it("cuts a response that exceeds the byte limit", async () => {
    const p = new GuardedProxy({ guard: createSsrfGuard({ allow: `127.0.0.1:${new URL(edge).port}` }), host: "127.0.0.1", port: 0, maxTunnelBytes: 50_000 });
    const port = (await p.listen()).port;
    try {
      const got = await new Promise<number>((resolve) => {
        let n = 0;
        const r = http.get({ host: "127.0.0.1", port, path: `${edge}/huge`, headers: { host: new URL(edge).host } }, (res) => {
          res.on("data", (c) => (n += c.length));
          res.on("end", () => resolve(n));
          res.on("close", () => resolve(n));
        });
        r.on("error", () => resolve(n));
      });
      expect(got).toBeLessThan(5_000_000);
    } finally {
      await p.close();
    }
  });
});
