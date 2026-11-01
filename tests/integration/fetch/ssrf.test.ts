import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFetcher, createSsrfGuard, FetchError, SsrfError, type Fetcher, type Resolver } from "../../../packages/fetch/src";
import { getJson, startFixtures, type Fixtures } from "./helpers";

let fx: Fixtures;
let bait: string;
let edge: string;
let targets: Record<string, { url: string; hitsCanary?: boolean }>;
let fetcher: Fetcher;

const canary = async () => (await getJson<{ hits: number }>(`${bait}/__canary`)).hits;
// Needs real DNS in the wild; here a stub resolver maps them to loopback.
const STUBBED = new Set(["localtestMe", "nipIo"]);
const stubResolver: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];

beforeAll(async () => {
  fx = await startFixtures();
  bait = fx.urls.ssrfBait!;
  edge = fx.urls.edge!;
  targets = await getJson(`${bait}/__targets`);
  // The edge site is the only allowed private origin; the bait origin (and so its loopback canary) is not.
  const edgePort = new URL(edge).port;
  fetcher = createFetcher({ ssrf: createSsrfGuard({ allow: `127.0.0.1:${edgePort}`, resolver: stubResolver }), maxBytes: 100_000 });
});
beforeEach(async () => {
  await fetch(`${bait}/__canary/reset`);
});
afterAll(async () => {
  await fetcher.close();
  await fx.close();
});

describe("every ssrfBait target is refused before a connection", () => {
  it("lists the expected targets", () => {
    for (const k of ["loopback", "ipv6Loopback", "metadata", "private10", "cgnat", "decimal", "hex", "hexFull", "octal", "ipv4Mapped", "ipv4MappedHex", "unspecified", "localhost", "userinfoTrick", "fileScheme", "ftpScheme", "gopher", "oddPort"]) {
      expect(targets[k], k).toBeTruthy();
    }
  });

  it("direct fetch: SSRF error, canary stays 0", async () => {
    for (const [name, t] of Object.entries(targets)) {
      try {
        await fetcher.fetch(t.url);
        throw new Error(`${name} was not blocked`);
      } catch (e) {
        expect(e, name).toBeInstanceOf(FetchError);
        expect((e as FetchError).code, `${name}: ${(e as Error).message}`).toBe("ssrf_blocked");
      }
    }
    expect(await canary()).toBe(0);
  });

  it("guard.checkUrl alone (no resolver, no network) blocks the literal and scheme targets", () => {
    const guard = createSsrfGuard();
    for (const [name, t] of Object.entries(targets)) {
      if (STUBBED.has(name)) continue;
      expect(() => guard.checkUrl(t.url), name).toThrow(SsrfError);
    }
  });

  it("redirect from an allowed host to each target is revalidated", async () => {
    for (const [name, t] of Object.entries(targets)) {
      for (const code of [301, 302, 307]) {
        const e = await fetcher.fetch(`${edge}/redirect/to?url=${encodeURIComponent(t.url)}&code=${code}`).then(
          () => null,
          (err) => err as FetchError,
        );
        expect(e, `${name} via ${code}`).toBeInstanceOf(FetchError);
        expect(e!.code, `${name}: ${e!.message}`).toBe("ssrf_blocked");
        expect(e!.redirects.length, name).toBe(1);
      }
    }
    expect(await canary()).toBe(0);
  });

  it("a multi-hop redirect that lands on the bait redirect endpoint is blocked at the bait hop", async () => {
    const e = await fetcher.fetch(`${edge}/redirect/to?url=${encodeURIComponent(`${bait}/redirect/via-public`)}`).catch((x) => x as FetchError);
    expect(e).toBeInstanceOf(FetchError);
    expect((e as FetchError).code).toBe("ssrf_blocked");
    expect(await canary()).toBe(0);
  });

  it("the bait pages themselves are unreachable (their origin is loopback)", async () => {
    for (const p of ["/page/links", "/page/assets", "/page/css", "/page/meta-refresh", "/__canary"]) {
      const e = await fetcher.fetch(`${bait}${p}`).catch((x) => x as FetchError);
      expect((e as FetchError).code).toBe("ssrf_blocked");
    }
    expect(await canary()).toBe(0);
  });

  it("hostnames that resolve to private addresses are blocked in the connect lookup", async () => {
    const url = new URL(targets.loopback!.url);
    const e = await fetcher.fetch(`http://fixture.example.test:${url.port}/canary`).catch((x) => x as FetchError);
    expect((e as FetchError).code).toBe("ssrf_blocked");
    expect((e as FetchError).ssrfReason).toBe("resolved_address");
    expect(await canary()).toBe(0);
  });

  it("DNS rebinding: a name that is public at check time and private at connect time never connects", async () => {
    let lookups = 0;
    const url = new URL(targets.loopback!.url);
    const rebinding = createFetcher({
      ssrf: createSsrfGuard({
        // first lookup public, later ones private
        resolver: async () => [{ address: lookups++ === 0 ? "93.184.216.34" : "127.0.0.1", family: 4 }],
      }),
      timeouts: { connectMs: 300 },
    });
    // First attempt would try to reach a public address (not reachable here): consume it.
    await rebinding.fetch(`http://rebind.example.test:${url.port}/canary`).catch(() => undefined);
    const e = await rebinding.fetch(`http://rebind.example.test:${url.port}/canary`).catch((x) => x as FetchError);
    expect((e as FetchError).code).toBe("ssrf_blocked");
    expect(lookups).toBeGreaterThanOrEqual(2);
    await rebinding.close();
    expect(await canary()).toBe(0);
  });
});

describe("operator allowlist", () => {
  it("allows an intentionally listed private origin", async () => {
    const port = new URL(bait).port;
    const f = createFetcher({ ssrf: createSsrfGuard({ allow: `127.0.0.1:${port}` }) });
    const r = await f.fetch(`${bait}/__health`);
    expect(r.status).toBe(200);
    expect(JSON.parse((r.body as Buffer).toString()).ok).toBe(true);
    await f.close();
    expect(await canary()).toBe(0);
  });
  it("allows by hostname via a resolver, and only that hostname", async () => {
    const edgePort = new URL(edge).port;
    const f = createFetcher({ ssrf: createSsrfGuard({ allow: "nas.test", resolver: stubResolver }) });
    expect((await f.fetch(`http://nas.test:${edgePort}/final`)).status).toBe(200);
    const e = await f.fetch(`http://other.test:${edgePort}/final`).catch((x) => x as FetchError);
    expect((e as FetchError).code).toBe("ssrf_blocked");
    await f.close();
  });
  it("is empty by default", async () => {
    const f = createFetcher({ ssrf: createSsrfGuard() });
    const e = await f.fetch(`${edge}/final`).catch((x) => x as FetchError);
    expect((e as FetchError).code).toBe("ssrf_blocked");
    await f.close();
  });
});
