import dns from "node:dns";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSsrfGuard, isSsrfError, SsrfError, type Resolver } from "@ncb/fetch";
import { BAD_SCHEMES, BLOCKED_PORTS, FAKE_DNS, MALFORMED, PRIVATE_V4, PRIVATE_V6, PUBLIC_V4, directTargets, redirectLocations, v4Spellings, v6Spellings } from "./ssrf-corpus.js";

/**
 * H-03 SSRF fuzzing, part 1: the guard itself. Nothing here opens a socket. Every spelling of every private address is refused by
 * `checkUrl` (literals, schemes, credentials, ports) or by the connect-time `lookup` (names), and public addresses still pass.
 * Part 2 (ssrf-entrypoints.test.ts) drives the same corpus through every place the server fetches a URL.
 */

const CANARY = 41999; // nothing listens here; the guard must refuse before any connection is tried

const fakeResolver: Resolver = async (host) => {
  const key = Object.keys(FAKE_DNS).find((k) => k.toLowerCase().replace(/\.$/, "") === host.toLowerCase().replace(/\.$/, ""));
  const addrs = key ? FAKE_DNS[key]! : ["93.184.216.34"]; // anything else is "public"
  return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
};

const guard = createSsrfGuard({ resolver: fakeResolver });

/** What happens to a URL: refused by checkUrl, or accepted by checkUrl and then refused when the name is resolved. */
async function outcome(url: string): Promise<{ refusedAt: "url" | "lookup" | "none"; reason?: string }> {
  let parsed: URL;
  try {
    parsed = guard.checkUrl(url);
  } catch (e) {
    return { refusedAt: "url", reason: (e as SsrfError).reason };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const err = await new Promise<Error | null>((resolve) => guard.lookup(host, { all: true }, (e) => resolve(e)));
  return err ? { refusedAt: "lookup", reason: isSsrfError(err)?.reason } : { refusedAt: "none" };
}

describe("the corpus is refused", () => {
  const targets = directTargets(CANARY);

  it("has a broad corpus", () => {
    expect(targets.length).toBeGreaterThan(450);
  });

  it("refuses every direct target, at the URL or at name resolution", async () => {
    const leaks: string[] = [];
    for (const t of targets) {
      const o = await outcome(t.url);
      if (o.refusedAt === "none") leaks.push(`${t.name}: ${t.url}`);
    }
    expect(leaks).toEqual([]);
  });

  it("refuses every redirect target when the redirect is resolved against an allowed page", () => {
    const bad: string[] = [];
    for (const r of redirectLocations(CANARY)) {
      try {
        const next = guard.checkRedirect("http://good.example/start", r.location);
        // names are checked when connecting, so a name that passes here must be one the fake DNS knows to be private
        if (!/example$|internal$/.test(next.hostname.replace(/\.$/, ""))) bad.push(`${r.name}: ${r.location} -> ${next.href}`);
      } catch (e) {
        if (!(e instanceof SsrfError)) bad.push(`${r.name}: threw ${(e as Error).message}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("refuses malformed URLs", () => {
    const bad = MALFORMED.filter((u) => {
      try {
        guard.checkUrl(u);
        return true;
      } catch (e) {
        return !(e instanceof SsrfError);
      }
    });
    expect(bad).toEqual([]);
  });

  it("refuses every non-http scheme, upper case and padded included", () => {
    for (const u of BAD_SCHEMES) expect(() => guard.checkUrl(u), u).toThrow(SsrfError);
  });

  it("refuses service ports on a public name, and allows the web ports", () => {
    for (const p of BLOCKED_PORTS) expect(() => guard.checkUrl(`http://public.example:${p}/`), String(p)).toThrow(/port/);
    expect(() => guard.checkUrl("http://public.example/")).not.toThrow();
    expect(() => guard.checkUrl("https://public.example:8443/")).not.toThrow();
    const strict = createSsrfGuard({ portPolicy: "strict" });
    expect(() => strict.checkUrl("http://public.example:8080/")).toThrow(/port/);
  });

  it("does not refuse everything: public addresses and names pass in every spelling", async () => {
    for (const o of PUBLIC_V4) {
      for (const host of v4Spellings(o)) expect((await outcome(`http://${host}/`)).refusedAt, host).toBe("none");
    }
    for (const u of ["http://example.com/", "https://sub.example.org:8443/a?b=c#d", "http://EXAMPLE.com./", "http://xn--bcher-kva.example/", "https://[2606:4700:4700::1111]/"]) {
      expect((await outcome(u)).refusedAt, u).toBe("none");
    }
    // backslash makes the authority end at the backslash: the host is example.com, not 127.0.0.1
    expect(guard.checkUrl("http://example.com\\@127.0.0.1/x").hostname).toBe("example.com");
  });
});

describe("DNS answers are judged when the connection is made", () => {
  it("a name with one private address among public ones only ever yields the allowed addresses", async () => {
    const mixed = createSsrfGuard({ resolver: async () => [{ address: "10.0.0.5", family: 4 }, { address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }] });
    const addrs = await new Promise<dns.LookupAddress[]>((resolve, reject) => mixed.lookup("mixed.example", { all: true }, (e, a) => (e ? reject(e) : resolve(a as dns.LookupAddress[]))));
    expect(addrs.map((a) => a.address)).toEqual(["93.184.216.34"]);
    const single = await new Promise<string>((resolve, reject) => mixed.lookup("mixed.example", {}, (e, a) => (e ? reject(e) : resolve(a as string))));
    expect(single).toBe("93.184.216.34");
  });

  it("a name that rebinds (public, then private) is judged on every lookup, not once", async () => {
    let calls = 0;
    const rebinding = createSsrfGuard({ resolver: async () => [{ address: calls++ === 0 ? "93.184.216.34" : "127.0.0.1", family: 4 }] });
    const first = await new Promise<Error | null>((resolve) => rebinding.lookup("rebind.example", { all: true }, (e) => resolve(e)));
    expect(first).toBeNull();
    for (let i = 0; i < 3; i++) {
      const again = await new Promise<Error | null>((resolve) => rebinding.lookup("rebind.example", { all: true }, (e) => resolve(e)));
      expect(isSsrfError(again)?.reason).toBe("resolved_address");
    }
    expect(calls).toBe(4); // nothing was cached between the check and the use
  });

  it("an IP literal never goes to the resolver, and a literal that is private is refused even without one", async () => {
    let calls = 0;
    const g = createSsrfGuard({ resolver: async () => { calls++; return [{ address: "93.184.216.34", family: 4 }]; } });
    for (const host of ["127.0.0.1", "10.0.0.1", "::1", "169.254.169.254"]) {
      const e = await new Promise<Error | null>((resolve) => g.lookup(host, { all: true }, (err) => resolve(err)));
      expect(isSsrfError(e), host).toBeTruthy();
    }
    expect(calls).toBe(0);
  });

  it("a resolver failure is an error, never a fallthrough", async () => {
    const g = createSsrfGuard({ resolver: async () => { throw Object.assign(new Error("boom"), { code: "ENOTFOUND" }); } });
    const e = await new Promise<Error | null>((resolve) => g.lookup("gone.example", { all: true }, (err) => resolve(err)));
    expect(e).toBeTruthy();
    const empty = createSsrfGuard({ resolver: async () => [] });
    const e2 = await new Promise<Error | null>((resolve) => empty.lookup("empty.example", { all: true }, (err) => resolve(err)));
    expect(isSsrfError(e2)?.reason).toBe("resolved_address");
  });
});

describe("property: any spelling of a private IPv4 address is refused", () => {
  const octets = (lo: number[], hi: number[]) => fc.tuple(...lo.map((l, i) => fc.integer({ min: l, max: hi[i]! }))) as fc.Arbitrary<[number, number, number, number]>;
  const RANGES: [string, [number, number, number, number], [number, number, number, number]][] = [
    ["0/8", [0, 0, 0, 0], [0, 255, 255, 255]], ["10/8", [10, 0, 0, 0], [10, 255, 255, 255]], ["100.64/10", [100, 64, 0, 0], [100, 127, 255, 255]],
    ["127/8", [127, 0, 0, 0], [127, 255, 255, 255]], ["169.254/16", [169, 254, 0, 0], [169, 254, 255, 255]], ["172.16/12", [172, 16, 0, 0], [172, 31, 255, 255]],
    ["192.0.0/24", [192, 0, 0, 0], [192, 0, 0, 255]], ["192.168/16", [192, 168, 0, 0], [192, 168, 255, 255]], ["198.18/15", [198, 18, 0, 0], [198, 19, 255, 255]],
    ["224/4", [224, 0, 0, 0], [239, 255, 255, 255]], ["240/4", [240, 0, 0, 0], [255, 255, 255, 255]],
  ];
  const privateIp = fc.oneof(...RANGES.map(([, lo, hi]) => octets(lo, hi)));
  const radix = fc.constantFrom(10, 16, 8);
  const render = (o: [number, number, number, number], mode: number, r: number[]): string => {
    const part = (x: number, rx: number) => (rx === 16 ? "0x" + x.toString(16) : rx === 8 && x > 0 ? "0" + x.toString(8) : String(x));
    const v = ((o[0] * 2 ** 24) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
    switch (mode % 5) {
      case 0: return o.map((x, i) => part(x, r[i]!)).join(".");
      case 1: return part(v, r[0]!);
      case 2: return `${part(o[0], r[0]!)}.${part(o[1], r[1]!)}.${part((o[2] << 8) + o[3], r[2]!)}`;
      case 3: return `${part(o[0], r[0]!)}.${part((o[1] << 16) + (o[2] << 8) + o[3], r[1]!)}`;
      default: return o.map((x, i) => part(x, r[i]!)).join(".") + ".";
    }
  };

  it("refuses private IPv4 in dotted, decimal, hex, octal, mixed, short and trailing-dot spellings", () => {
    fc.assert(
      fc.property(privateIp, fc.integer({ min: 0, max: 4 }), fc.array(radix, { minLength: 4, maxLength: 4 }), (o, mode, r) => {
        const host = render(o, mode, r);
        let refused = false;
        try { guard.checkUrl(`http://${host}:${CANARY}/x`); } catch (e) { refused = e instanceof SsrfError; }
        return refused;
      }),
      { numRuns: 4000 },
    );
  });

  it("refuses private IPv4 embedded in mapped, compatible, NAT64, 6to4 and SIIT IPv6 forms", () => {
    fc.assert(
      fc.property(privateIp, fc.integer({ min: 0, max: 12 }), (o, i) => {
        const hosts = v6Spellings(o);
        const host = hosts[i % hosts.length]!;
        let refused = false;
        try { guard.checkUrl(`http://[${host}]:${CANARY}/x`); } catch (e) { refused = e instanceof SsrfError; }
        return refused;
      }),
      { numRuns: 3000 },
    );
  });

  it("does not refuse public IPv4 in any spelling (no false positives)", () => {
    const publicIp = fc.constantFrom(...PUBLIC_V4);
    fc.assert(
      fc.property(publicIp, fc.integer({ min: 0, max: 4 }), fc.array(radix, { minLength: 4, maxLength: 4 }), (o, mode, r) => {
        const host = render(o, mode, r);
        try { guard.checkUrl(`http://${host}/x`); return true; } catch { return false; }
      }),
      { numRuns: 1000 },
    );
  });

  it("random garbage hosts never get through as something private: a refused URL stays refused", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        // whatever checkUrl accepts must have a public-looking host: no loopback name, no literal in a private range
        let u: URL;
        try { u = guard.checkUrl(`http://${s}/`); } catch { return true; }
        const h = u.hostname.toLowerCase().replace(/\.+$/, "");
        return h !== "localhost" && !h.endsWith(".localhost") && !/^(\[|)(::1|127\.|10\.|0\.0\.0\.0|169\.254\.)/.test(h);
      }),
      { numRuns: 3000 },
    );
  });
});

describe("the operator allowlist stays narrow", () => {
  it("allows exactly the listed host and port, nothing near it", () => {
    const g = createSsrfGuard({ allow: "10.0.0.5:8080" });
    expect(() => g.checkUrl("http://10.0.0.5:8080/")).not.toThrow();
    for (const u of ["http://10.0.0.5:8081/", "http://10.0.0.6:8080/", "http://10.0.0.5/", "http://127.0.0.1:8080/", "http://[::ffff:10.0.0.6]:8080/", "http://169.254.169.254:8080/"]) {
      expect(() => g.checkUrl(u), u).toThrow(SsrfError);
    }
    // an allowed IP literal does not allow a hostname that resolves to a neighbour
    expect(g.isAddressAllowed("10.0.0.6", "other.example")).toBe(false);
  });

  it("a port-bound entry does not open the address on other ports through a name", () => {
    const g = createSsrfGuard({ allow: "10.0.0.5:8080" });
    expect(g.isAddressAllowed("10.0.0.5", "name.example")).toBe(false);
  });

  it("an allowed host name allows the addresses it resolves to for that name only", async () => {
    const g = createSsrfGuard({ allow: "searx.lan", resolver: async () => [{ address: "192.168.1.9", family: 4 }] });
    const ok = await new Promise<Error | null>((resolve) => g.lookup("searx.lan", { all: true }, (e) => resolve(e)));
    expect(ok).toBeNull();
    const other = await new Promise<Error | null>((resolve) => g.lookup("evil.example", { all: true }, (e) => resolve(e)));
    expect(isSsrfError(other)?.reason).toBe("resolved_address");
    expect(() => g.checkUrl("http://searx.lan.evil.example/")).not.toThrow(); // a different name: judged by its own resolution above
    expect(g.isAddressAllowed("192.168.1.9", "searx.lan.evil.example")).toBe(false);
  });
});

describe("literal tables stay in step", () => {
  it("covers every v4 range and several v6 forms", () => {
    expect(PRIVATE_V4.length).toBeGreaterThanOrEqual(20);
    expect(PRIVATE_V6.length).toBeGreaterThanOrEqual(12);
    expect(v4Spellings([127, 0, 0, 1])).toContain("2130706433");
    expect(v4Spellings([127, 0, 0, 1])).toContain("0x7f000001");
    expect(v4Spellings([127, 0, 0, 1])).toContain("0177.0.0.01");
  });
});
