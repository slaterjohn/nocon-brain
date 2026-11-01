import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClockJumpDetector, FakeClock } from "@ncb/shared";
import { ArchiveTokenService, TOKEN_LIFETIME_SECONDS, archiveHeaders } from "../src/archive/index.js";

const secret = Buffer.alloc(32, 7);
const mk = (clock = new FakeClock()) => ({ clock, svc: new ArchiveTokenService({ secret, clock }) });
const input = { userId: "u1", frameId: "fr_1", appOrigin: "http://localhost:3000/some/path" };

describe("archive tokens", () => {
  it("mints v1.payload.signature with an 8 hour life and the app origin", () => {
    const { svc, clock } = mk();
    const t = svc.mint(input);
    expect(t).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    const r = svc.verify(t);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({ u: "u1", f: "fr_1", e: Math.floor(clock.now() / 1000) + TOKEN_LIFETIME_SECONDS, o: "http://localhost:3000" });
    }
  });
  it("rejects tampering with payload or signature", () => {
    const { svc } = mk();
    const [v, p, s] = svc.mint(input).split(".");
    const evil = Buffer.from(JSON.stringify({ u: "admin", f: "fr_1", e: 9e9, o: "http://evil.example" })).toString("base64url");
    expect(svc.verify(`${v}.${evil}.${s}`)).toEqual({ ok: false, reason: "bad-signature" });
    expect(svc.verify(`${v}.${p}.${s!.slice(0, -2)}AA`)).toEqual({ ok: false, reason: "bad-signature" });
    expect(svc.verify(`v2.${p}.${s}`)).toEqual({ ok: false, reason: "malformed" });
    expect(svc.verify("garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(svc.verify("")).toEqual({ ok: false, reason: "malformed" });
    expect(svc.verify("v1." + "a".repeat(2000) + ".x")).toEqual({ ok: false, reason: "malformed" });
  });
  it("expires after the lifetime on the injected clock", () => {
    const { svc, clock } = mk();
    const t = svc.mint(input);
    clock.advance((TOKEN_LIFETIME_SECONDS - 1) * 1000);
    expect(svc.verify(t).ok).toBe(true);
    clock.advance(2000);
    expect(svc.verify(t)).toEqual({ ok: false, reason: "expired" });
  });
  it("does not expire inside the grace period after a clock jump", () => {
    const clock = new FakeClock();
    const jumps = new ClockJumpDetector({ clock });
    const svc = new ArchiveTokenService({ secret, clock, jumps });
    const t = svc.mint(input);
    clock.jumpWall(TOKEN_LIFETIME_SECONDS * 1000 + 60_000);
    expect(svc.verify(t).ok).toBe(true);
  });
  it("binds a token to its frame when asked", () => {
    const { svc } = mk();
    const t = svc.mint(input);
    expect(svc.verify(t, { frameId: "fr_1" }).ok).toBe(true);
    expect(svc.verify(t, { frameId: "fr_2" })).toEqual({ ok: false, reason: "wrong-frame" });
  });
  it("rejects tokens from another secret", () => {
    const clock = new FakeClock();
    const other = new ArchiveTokenService({ secret: Buffer.alloc(32, 9), clock });
    expect(mk(clock).svc.verify(other.mint(input))).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("archive headers", () => {
  it("carries the full set and adds popup flags only when asked", () => {
    const h = archiveHeaders({ appOrigin: "http://localhost:3000" });
    expect(h["content-security-policy"]).toMatch(/^sandbox; default-src 'none'/);
    expect(h["content-security-policy"]).toContain("connect-src 'none'");
    expect(h["content-security-policy"]).toContain("form-action 'none'");
    expect(h["content-security-policy"]).toContain("frame-ancestors http://localhost:3000");
    expect(h["content-security-policy"]).not.toContain("allow-");
    expect(archiveHeaders({ appOrigin: "x", popups: true })["content-security-policy"]).toMatch(/^sandbox allow-popups allow-popups-to-escape-sandbox;/);
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(Object.keys(h).some((k) => /cookie/i.test(k))).toBe(false);
  });
});

describe("import boundary", () => {
  it("the listener has no outbound network dependency and never touches cookies", () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/archive");
    const forbidden = [
      /from\s+["'](node:)?(https|http2|net|dns|tls|dgram)["']/,
      /from\s+["']undici["']/,
      /from\s+["']@ncb\/fetch["']/,
      /from\s+["']@ncb\/db["']/,
      /services\/fetcher/,
      /\bfetch\s*\(/,
      /http\.request|http\.get\s*\(/,
      /headers\.cookie|headers\[["']cookie["']\]|["']set-cookie["']\s*:/i,
    ];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const re of forbidden) expect(re.test(src), `${f} matches ${re}`).toBe(false);
    }
  });
});
