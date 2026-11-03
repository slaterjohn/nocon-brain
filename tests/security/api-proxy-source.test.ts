import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cidrMatcher } from "../../apps/server/src/lib/cidr.js";
import { call, PROXY_SECRET, startServer } from "../integration/server/helpers.js";

/**
 * H-03 finding: the shared proxy secret is also the default secret of the renderer and SearXNG containers (a copy of it in their
 * environment). The renderer shares the `render` network with `server`, so a compromised renderer could call the API with it. The secret
 * now only counts from the `backend` network (NCB_API_PROXY_FROM), where `web` lives, and SearXNG is no longer on that network.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = "172.31.249.7";
const RENDERER = "172.31.250.9";
const SEARXNG = "172.18.0.9";
const withSecret = (ip = "203.0.113.7") => ({ "x-nocon-proxy-secret": PROXY_SECRET, "x-nocon-client-ip": ip });

describe("NCB_API_PROXY_FROM", () => {
  it("honours the secret from the backend network and from nowhere else", async () => {
    const t = await startServer({ env: { NCB_API_PROXY_FROM: "172.31.249.0/24" } });
    const ok = await call(t, { url: "/api/settings", headers: withSecret(), remoteAddress: WEB });
    expect(ok.statusCode).not.toBe(403); // 409 setup_required: the request reached the application
    const mapped = await call(t, { url: "/api/settings", headers: withSecret(), remoteAddress: `::ffff:${WEB}` });
    expect(mapped.statusCode).not.toBe(403);
    for (const from of [RENDERER, SEARXNG, "10.0.0.5", "172.31.248.255", "172.31.250.0", "203.0.113.7", "::1:2:3:4"]) {
      const res = await call(t, { url: "/api/settings", headers: withSecret(), remoteAddress: from });
      expect(res.statusCode, from).toBe(403);
      expect(res.json().message, from).toMatch(/only accepts requests from the NoConBrain web app/);
    }
  });

  it("a forged client address from a wrong network is ignored too: no guest access and no login-throttle evasion", async () => {
    const first = await startServer({ env: { NCB_API_PROXY_FROM: "172.31.249.0/24" } });
    const login = (ip: string, from: string) => call(first, { url: "/api/auth/login", body: { username: "nobody", password: "wrong password" }, headers: withSecret(ip), remoteAddress: from });
    // from the renderer's network the secret is useless, whatever address it claims
    for (let i = 0; i < 30; i++) expect((await login(`198.51.100.${i + 1}`, RENDERER)).statusCode).toBe(403);
    // from the backend network the claimed client address is trusted as before
    expect((await login("198.51.100.1", WEB)).statusCode).not.toBe(403);
  });

  it("the health check and the container itself keep working without the secret", async () => {
    const t = await startServer({ env: { NCB_API_PROXY_FROM: "172.31.249.0/24" } });
    expect((await call(t, { url: "/api/system/health", remoteAddress: RENDERER })).statusCode).toBe(200);
    for (const addr of ["127.0.0.1", "::1"]) expect((await call(t, { url: "/api/settings", remoteAddress: addr })).statusCode, addr).not.toBe(403);
  });

  it("without it, the secret counts from anywhere (unchanged for installs that do not set it)", async () => {
    const t = await startServer();
    expect((await call(t, { url: "/api/settings", headers: withSecret(), remoteAddress: RENDERER })).statusCode).not.toBe(403);
  });

  it("a malformed range stops the server from starting rather than silently allowing everything", async () => {
    await expect(startServer({ env: { NCB_API_PROXY_FROM: "not-a-cidr" } })).rejects.toThrow();
    await expect(startServer({ env: { NCB_API_PROXY_FROM: "10.0.0.0/99" } })).rejects.toThrow();
  });

  it("matcher: ranges, families and the mapped form", () => {
    const m = cidrMatcher(["172.31.249.0/24", "fd00:1::/64"]);
    expect([m("172.31.249.1"), m("::ffff:172.31.249.200"), m("fd00:1::5")]).toEqual([true, true, true]);
    expect([m("172.31.250.1"), m("fd00:2::5"), m("garbage"), m("")]).toEqual([false, false, false, false]);
  });
});

describe("compose.yml keeps the renderer and SearXNG away from the API", () => {
  const compose = fs.readFileSync(path.join(root, "compose.yml"), "utf8");
  const service = (name: string) => {
    const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|^networks:)`, "m").exec(compose);
    return m?.[1] ?? "";
  };

  it("server passes the backend subnet as the only place the proxy secret counts", () => {
    expect(service("server")).toMatch(/NCB_API_PROXY_FROM: \$\{NCB_BACKEND_SUBNET:-172\.31\.249\.0\/24\}/);
    expect(compose).toMatch(/backend:\n    internal: true\n    ipam:\n      config:\n        - subnet: \$\{NCB_BACKEND_SUBNET:-172\.31\.249\.0\/24\}/);
  });

  it("SearXNG is not on the backend network and the renderer is only on render", () => {
    expect(service("searxng")).toMatch(/networks: \[egress\]/);
    expect(service("searxng")).not.toMatch(/backend/);
    expect(service("renderer")).toMatch(/networks: \[render\]/);
    expect(service("web")).toMatch(/networks: \[frontend, backend\]/);
  });

  it("every service drops all capabilities and blocks privilege gain; only the renderer adds one back", () => {
    expect(compose).toMatch(/x-hardening: &hardening\n  cap_drop: \[ALL\]\n  security_opt: \["no-new-privileges:true"\]/);
    for (const name of ["server", "web", "searxng", "renderer"]) expect(service(name), name).toMatch(/<<: \*hardening/);
    const adds = [...compose.matchAll(/cap_add: \[([A-Z_,\s]+)\]/g)].map((m) => m[1]!.trim());
    expect(adds).toEqual(["SYS_CHROOT"]);
    expect(service("renderer")).toMatch(/cap_add: \[SYS_CHROOT\]/);
    for (const name of ["server", "web", "searxng", "renderer"]) expect(service(name), name).toMatch(/read_only: true/);
    for (const name of ["server", "web", "searxng", "renderer"]) expect(service(name), name).toMatch(/pids_limit:/);
    expect(compose).not.toMatch(/privileged:\s*true|network_mode:\s*host|pid:\s*host|\/var\/run\/docker\.sock/);
  });

  it("publishes only the web port and the archive port", () => {
    expect([...compose.matchAll(/^    ports:/gm)].length).toBe(2);
    expect(service("server")).toMatch(/^    ports:\n(?:      #.*\n)*      - "\$\{NCB_ARCHIVE_BIND:-0\.0\.0\.0\}:\$\{NCB_ARCHIVE_PORT:-3002\}:\$\{NCB_ARCHIVE_PORT:-3002\}"/m);
    expect(service("web")).toMatch(/^    ports:\n      - "\$\{NCB_WEB_BIND:-0\.0\.0\.0\}:\$\{NCB_WEB_PORT:-3000\}:\$\{NCB_WEB_PORT:-3000\}"/m);
    expect(service("searxng") + service("renderer")).not.toMatch(/^    ports:/m);
    expect(compose).not.toMatch(/- "[^"\n]*:3001"/);
  });
});
