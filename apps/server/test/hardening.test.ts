import { describe, expect, it } from "vitest";
import { CidrError, resolveBindHost } from "../src/lib/cidr.js";
import { isLoopback } from "../src/app.js";
import { HostPacer, pacedFetcher } from "../src/limits/pacer.js";
import { failureFor } from "../src/downloads/failures.js";

describe("HB-07 resolveBindHost: a CIDR becomes this container's address inside that network", () => {
  const ifaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    eth0: [{ address: "172.20.0.3", family: "IPv4", internal: false }],
    eth1: [{ address: "172.31.250.2", family: 4, internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
    eth2: [{ address: "172.19.0.4", family: "IPv4", internal: false }],
  };
  it("leaves a plain address alone", () => {
    expect(resolveBindHost("0.0.0.0", ifaces)).toBe("0.0.0.0");
    expect(resolveBindHost("127.0.0.1", ifaces)).toBe("127.0.0.1");
  });
  it("picks the interface whose address is inside the range, and only that one", () => {
    expect(resolveBindHost("172.31.250.0/24", ifaces)).toBe("172.31.250.2");
    expect(resolveBindHost("172.19.0.0/16", ifaces)).toBe("172.19.0.4");
    expect(resolveBindHost("fe80::/10", ifaces)).toBe("fe80::1");
  });
  it("fails, rather than listening everywhere, when the container has no address in the range", () => {
    expect(() => resolveBindHost("10.9.0.0/24", ifaces)).toThrow(CidrError);
    expect(() => resolveBindHost("10.9.0.0/24", ifaces)).toThrow(/no address in 10\.9\.0\.0\/24/);
    expect(() => resolveBindHost("not-a-cidr/24", ifaces)).toThrow(CidrError);
  });
});

describe("HB-01 isLoopback", () => {
  it("accepts loopback in every spelling and nothing else", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", undefined]) expect(isLoopback(a), String(a)).toBe(true);
    for (const a of ["172.18.0.5", "10.0.0.1", "192.168.1.1", "::ffff:10.0.0.1", "fe80::1", "2001:db8::1"]) expect(isLoopback(a), a).toBe(false);
  });
});

describe("HB-05 HostPacer", () => {
  function setup(delays: Record<string, number>, assetGapMs?: number) {
    let now = 1_000;
    const slept: number[] = [];
    const pacer = new HostPacer({
      delayOf: (h) => delays[h] ?? 0, assetGapMs, monotonic: () => now,
      sleep: async (ms) => { slept.push(ms); now += ms; },
    });
    return { pacer, slept, advance: (ms: number) => { now += ms; }, at: () => now };
  }

  it("never holds up a host nobody crawls", async () => {
    const { pacer, slept } = setup({});
    for (const k of ["robots", "page", "asset", "asset"] as const) await pacer.wait("quiet.test", k);
    expect(slept).toEqual([]);
  });

  it("spaces robots.txt and the first page request by the host delay", async () => {
    const { pacer, slept } = setup({ "a.test": 1500 });
    await pacer.wait("a.test", "robots");
    await pacer.wait("a.test", "page");
    expect(slept).toEqual([1500]);
  });

  it("spaces files by the smaller asset gap, one by one, however many ask at once", async () => {
    const { pacer, slept } = setup({ "a.test": 1500 }, 250);
    await pacer.wait("a.test", "page");
    await Promise.all([1, 2, 3, 4].map(() => pacer.wait("a.test", "asset")));
    // Asked together, each gets its own slot 250 ms after the one before (the fake sleep moves time on, so each sees a 250 ms wait): one second in all.
    expect(slept).toEqual([250, 250, 250, 250]);
  });

  it("is per host: another host is not slowed by the first", async () => {
    const { pacer, slept } = setup({ "a.test": 1000, "b.test": 1000 });
    await pacer.wait("a.test", "page");
    await pacer.wait("b.test", "page");
    expect(slept).toEqual([]);
    await pacer.wait("a.test", "page");
    expect(slept).toEqual([1000 - 0]);
  });

  it("does not wait once the gap has passed", async () => {
    const { pacer, slept, advance } = setup({ "a.test": 1000 });
    await pacer.wait("a.test", "page");
    advance(1200);
    await pacer.wait("a.test", "page");
    expect(slept).toEqual([]);
  });

  it("a waiter can be cancelled", async () => {
    const pacer = new HostPacer({ delayOf: () => 5000 });
    await pacer.wait("a.test", "page");
    const ac = new AbortController();
    const p = pacer.wait("a.test", "page", ac.signal);
    ac.abort(new Error("stopped"));
    await expect(p).rejects.toThrow("stopped");
  });

  it("pacedFetcher waits before the inner fetch, by kind", async () => {
    const { pacer, slept } = setup({ "a.test": 1000 });
    const calls: string[] = [];
    const inner = { fetch: async (u: string) => { calls.push(u); return { status: 200 }; } };
    const f = pacedFetcher<{ signal?: AbortSignal; pace?: "robots" | "page" | "asset" }, typeof inner>(inner, pacer, (o) => o?.pace ?? "page");
    await f.fetch("http://a.test/robots.txt", { pace: "robots" });
    expect(calls).toEqual(["http://a.test/robots.txt"]);
    // A page is paced in the beforeHop hook, after the caller's own hook (which reads robots.txt), and again for a redirect hop.
    const order: string[] = [];
    const hooked = { fetch: async (u: string, o?: { hooks?: { beforeHop?: (i: { url: string }) => void | Promise<void> } }) => { order.push("hop"); await o?.hooks?.beforeHop?.({ url: u }); order.push("request"); } };
    const g = pacedFetcher<{ signal?: AbortSignal; pace?: "page"; hooks?: { beforeHop?: (i: { url: string }) => void | Promise<void> } }, typeof hooked>(hooked, pacer, () => "page");
    await g.fetch("http://a.test/page", { hooks: { beforeHop: () => { order.push("robots check"); } } });
    expect(order).toEqual(["hop", "robots check", "request"]);
    expect(slept).toEqual([1000]);
  });
});

describe("failure messages are sentences", () => {
  it("capitalises and ends the raw detail", () => {
    expect(failureFor("network", "other side closed").message).toBe("The site could not be reached. Other side closed.");
    expect(failureFor("http_5xx", "The server answered 503.").message).toBe("The site reported an error of its own. The server answered 503.");
    expect(failureFor("timeout").message).toBe("The site took too long to answer.");
  });
});
