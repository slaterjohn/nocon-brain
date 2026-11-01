import { describe, expect, it } from "vitest";
import { FakeClock } from "@ncb/shared";
import { CidrError, isPrivateCidr, privateCidrMatcher } from "../src/lib/cidr.js";
import { LoginThrottle } from "../src/lib/throttle.js";
import { hashPassword, verifyPassword, MAX_SCRYPT, scryptStats } from "../src/lib/password.js";
import { decryptSecret, encryptSecret } from "../src/lib/secrets.js";
import { PASSIVE_OFFLINE_AFTER, reduceConnectivity, type Observed } from "../src/services/connectivity.js";
import { mountInfoFor } from "../src/services/volumes.js";
import { EventBus } from "../src/services/events.js";

describe("password", () => {
  it("hashes and verifies, never accepting a wrong or malformed hash", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", "bcrypt$nope")).toBe(false);
  });

  it("limits concurrent scrypt operations to 2", async () => {
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, scryptStats().active)), 1);
    await Promise.all(Array.from({ length: 6 }, () => hashPassword("pw")));
    clearInterval(timer);
    expect(MAX_SCRYPT).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });
});

describe("login throttle", () => {
  it("allows 5 a minute per IP and records the attempt at check time", () => {
    const c = new FakeClock();
    const t = new LoginThrottle(c);
    for (let i = 0; i < 5; i++) expect(t.check("1.1.1.1", `u${i}`)).toBe(0);
    expect(t.check("1.1.1.1", "u9")).toBeGreaterThan(0);
    expect(t.check("2.2.2.2", "u9")).toBe(0);
    c.advance(61_000);
    expect(t.check("1.1.1.1", "u9")).toBe(0);
  });
  it("allows 20 an hour per username, case-insensitively, and clear() forgives", () => {
    const c = new FakeClock();
    const t = new LoginThrottle(c);
    for (let i = 0; i < 20; i++) expect(t.check(`10.0.0.${i}`, i % 2 ? "Admin" : "admin")).toBe(0);
    expect(t.check("10.0.1.1", "ADMIN")).toBeGreaterThan(0);
    t.clear("10.0.1.1", "admin");
    expect(t.check("10.0.1.1", "admin")).toBe(0);
  });
});

describe("cidr", () => {
  it("accepts only private ranges", () => {
    for (const ok of ["192.168.1.0/24", "10.0.0.0/8", "172.16.0.0/12", "127.0.0.1", "fd00::/8", "fe80::/10"]) expect(isPrivateCidr(ok), ok).toBe(true);
    for (const bad of ["0.0.0.0/0", "8.8.8.0/24", "10.0.0.0/4", "172.0.0.0/8", "::/0", "2001:db8::/32"]) expect(isPrivateCidr(bad), bad).toBe(false);
    expect(() => privateCidrMatcher(["8.8.8.0/24"])).toThrow(CidrError);
    expect(() => privateCidrMatcher(["nonsense"])).toThrow(CidrError);
  });
  it("matches addresses including IPv4-mapped IPv6", () => {
    const m = privateCidrMatcher(["192.168.1.0/24", "fd00::/8"]);
    expect(m("192.168.1.77")).toBe(true);
    expect(m("::ffff:192.168.1.77")).toBe(true);
    expect(m("192.168.2.1")).toBe(false);
    expect(m("fd12::1")).toBe(true);
    expect(m("not an ip")).toBe(false);
  });
});

describe("secrets", () => {
  it("round-trips and detects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const enc = encryptSecret(key, "hunter2");
    expect(enc).not.toContain("hunter2");
    expect(decryptSecret(key, enc)).toBe("hunter2");
    expect(() => decryptSecret(Buffer.alloc(32, 8), enc)).toThrow();
    expect(() => decryptSecret(key, enc.slice(0, -2) + "AA")).toThrow();
  });
});

describe("connectivity state machine", () => {
  const start: Observed = { state: "unknown", source: "passive", failures: 0 };
  it("goes online on success, offline after repeated network failures, back online on success", () => {
    let s = reduceConnectivity(start, { type: "network_failure" });
    expect(s.state).toBe("unknown");
    for (let i = 1; i < PASSIVE_OFFLINE_AFTER; i++) s = reduceConnectivity(s, { type: "network_failure" });
    expect(s).toMatchObject({ state: "offline", source: "passive" });
    s = reduceConnectivity(s, { type: "success" });
    expect(s).toMatchObject({ state: "online", failures: 0 });
  });
  it("lets a probe decide in both directions", () => {
    expect(reduceConnectivity(start, { type: "probe", ok: false })).toMatchObject({ state: "offline", source: "probe" });
    expect(reduceConnectivity({ state: "offline", source: "probe", failures: 3 }, { type: "probe", ok: true })).toMatchObject({ state: "online", source: "probe", failures: 0 });
  });
  it("a success resets the failure count", () => {
    let s = reduceConnectivity(start, { type: "network_failure" });
    s = reduceConnectivity(s, { type: "success" });
    s = reduceConnectivity(s, { type: "network_failure" });
    expect(s.state).toBe("online");
  });
});

describe("volume helpers and event bus", () => {
  it("parses mountinfo and picks the longest mount point", () => {
    const text = [
      "20 1 8:1 / / rw - ext4 /dev/root rw",
      "30 20 179:2 / /volumes/default rw - ext4 /dev/mmcblk0p2 rw",
    ].join("\n");
    expect(mountInfoFor("/volumes/default/x", text)).toMatchObject({ mountPoint: "/volumes/default", source: "/dev/mmcblk0p2" });
    expect(mountInfoFor("/data", text)).toMatchObject({ mountPoint: "/" });
    expect(mountInfoFor("/data", null)).toBeNull();
  });
  it("replays events after an id from a bounded ring", () => {
    const bus = new EventBus(new FakeClock(), 3);
    for (let i = 0; i < 5; i++) bus.publish("t", i);
    expect(bus.since(0).map((e) => e.data)).toEqual([2, 3, 4]);
    expect(bus.since(4).map((e) => e.data)).toEqual([4]);
  });
});
