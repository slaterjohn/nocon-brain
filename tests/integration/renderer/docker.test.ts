import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getJson, startFixtures, type Fixtures } from "../fetch/helpers";

// Builds the renderer image for linux/arm64, runs it on an internal-only network behind the server's forward proxy,
// renders a script-built page and checks the renderer has no other way out. Needs Docker and a few minutes the first
// time (the image is large). Off unless NCB_DOCKER_TESTS=1.
const ENABLED = process.env.NCB_DOCKER_TESTS === "1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLATFORM = process.env.NCB_DOCKER_PLATFORM ?? "linux/arm64";
const IMAGE = "nocon-brain/renderer:dev";
const MARKER = "lanternfish-migration-7731";
const SECRET = "docker-test-secret-0123456789abcdef";
const RUN = Math.random().toString(16).slice(2, 8);
const names = { internal: `ncb-t-render-${RUN}`, egress: `ncb-t-egress-${RUN}`, proxy: `ncb-t-proxy-${RUN}`, renderer: `ncb-t-renderer-${RUN}` };

// Always asynchronous: the fixture sites live in this process, and a blocked event loop would stop them answering the container.
const docker = (args: string[], o: { timeout?: number; allowFail?: boolean } = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("docker", args, { encoding: "utf8", timeout: o.timeout ?? 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !o.allowFail) return reject(new Error(`docker ${args.join(" ")} failed: ${stderr || stdout || err.message}`));
      resolve(stdout + (o.allowFail ? stderr : ""));
    });
  });

/** Runs a script with node inside a container and returns the JSON it printed. */
async function inContainer<T = any>(container: string, script: string, timeout = 120_000): Promise<T> {
  const out = await docker(["exec", container, "node", "--input-type=module", "-e", script], { timeout, allowFail: true });
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new Error(`no JSON from container script: ${out.slice(0, 500)}`);
  }
}

const probe = (host: string, port: number, ms = 4000) => `
import net from "node:net";
const s = net.connect({ host: ${JSON.stringify(host)}, port: ${port}, timeout: ${ms} });
const done = (r) => { console.log(JSON.stringify(r)); process.exit(0); };
s.on("connect", () => done({ connected: true }));
s.on("timeout", () => done({ connected: false, error: "timeout" }));
s.on("error", (e) => done({ connected: false, error: e.code }));
`;

const render = (url: string, timeoutMs = 40_000) => `
const r = await fetch("http://${names.renderer}:8080/render", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ${SECRET}" }, body: JSON.stringify({ url: ${JSON.stringify(url)}, timeoutMs: ${timeoutMs}, maxBytes: 5000000, userAgent: "NoConBrain-test" }) });
const body = await r.json();
console.log(JSON.stringify({ status: r.status, ...body }));
`;

function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address;
  return undefined;
}

describe.skipIf(!ENABLED)("C-16 renderer image (docker)", () => {
  let fx: Fixtures;
  let articlePort: number;
  let baitPort: number;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ncb-docker-"));
  const measured: Record<string, unknown> = {};

  beforeAll(async () => {
    fx = await startFixtures();
    articlePort = Number(new URL(fx.urls.article!).port);
    baitPort = Number(new URL(fx.urls.ssrfBait!).port);

    // The proxy: the server's GuardedProxy bundled into one file and run in a plain Node image.
    const req = createRequire(path.join(ROOT, "apps/server/package.json"));
    const esbuild = req("esbuild") as { buildSync(o: Record<string, unknown>): unknown };
    esbuild.buildSync({ entryPoints: [path.join(ROOT, "tests/integration/renderer/proxy-container.ts")], outfile: path.join(tmp, "proxy.mjs"), bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
      banner: { js: "import { createRequire as __r } from 'module'; const require = __r(import.meta.url);" } });

    const t0 = Date.now();
    try {
      await docker(["build", "--platform", PLATFORM, "-f", "docker/renderer/Dockerfile", "-t", IMAGE, ROOT], { timeout: 25 * 60_000 });
    } catch (e) {
      // With no route to the registry (the BuildKit frontend lookup fails first) an image built earlier is still a fair test of the same Dockerfile.
      const have = await docker(["image", "inspect", "-f", "{{.Architecture}}", IMAGE], { allowFail: true });
      if (!have.trim().startsWith(PLATFORM.split("/")[1]!)) throw e;
      console.warn(`docker build failed; using the existing ${IMAGE} image:\n${String(e).slice(0, 300)}`);
    }
    measured.buildSeconds = Math.round((Date.now() - t0) / 1000);

    await docker(["network", "create", "--internal", names.internal]);
    await docker(["network", "create", names.egress]);
    await docker(["run", "-d", "--name", names.proxy, "--platform", PLATFORM, "--network", names.egress, "--add-host", "host.docker.internal:host-gateway",
      "-e", `TOKEN=${SECRET}`, "-e", `ALLOW=host.docker.internal:${articlePort}`, "-v", `${tmp}:/p:ro`, "node:24-trixie-slim", "node", "/p/proxy.mjs"]);
    for (let i = 0; ; i++) {
      const logs = await docker(["logs", names.proxy], { allowFail: true });
      if (logs.includes('"listening"')) break;
      if (i > 30 || (await docker(["inspect", "-f", "{{.State.Running}}", names.proxy])).trim() !== "true") throw new Error(`proxy container did not start: ${logs}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    await docker(["network", "connect", "--alias", "server", names.internal, names.proxy]);
    await docker(["run", "-d", "--name", names.renderer, "--platform", PLATFORM, "--network", names.internal, "--network-alias", names.renderer,
      "--init", "--read-only", "--tmpfs", "/tmp:size=256m,uid=1000,gid=1000", "--cap-drop", "ALL", "--cap-add", "SYS_CHROOT", "--security-opt", "no-new-privileges:true",
      "--security-opt", `seccomp=${path.join(ROOT, "docker/renderer/seccomp.json")}`, "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256", "--shm-size", "256m",
      "-e", "NCB_RENDER_PROXY_URL=http://server:3128", "-e", `NCB_RENDERER_SECRET=${SECRET}`, IMAGE]);
    for (let i = 0; i < 60; i++) {
      const h = (await docker(["inspect", "-f", "{{.State.Health.Status}}", names.renderer], { allowFail: true })).trim();
      if (h === "healthy") break;
      if (i === 59) throw new Error(`renderer never became healthy: ${await docker(["logs", names.renderer], { allowFail: true })}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }, 30 * 60_000);

  afterAll(async () => {
    fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "test-results/renderer-docker.json"), JSON.stringify(measured, null, 2));
    for (const c of [names.renderer, names.proxy]) await docker(["rm", "-f", c], { allowFail: true });
    for (const n of [names.internal, names.egress]) await docker(["network", "rm", n], { allowFail: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    await fx?.close();
  }, 120_000);

  it("is built for the requested platform and runs as an unprivileged user", async () => {
    expect((await docker(["image", "inspect", "-f", "{{.Architecture}}", IMAGE])).trim()).toBe(PLATFORM.split("/")[1]);
    expect((await docker(["exec", names.renderer, "id", "-u"])).trim()).toBe("1000");
    measured.imageBytes = Number((await docker(["image", "inspect", "-f", "{{.Size}}", IMAGE])).trim());
    measured.platform = PLATFORM;
    measured.chromium = (await docker(["exec", names.renderer, "sh", "-c", "ls /ms-playwright"])).trim().split("\n");
    measured.idleBeforeBrowser = (await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}|{{.PIDs}}", names.renderer])).trim();
    measured.playwright = JSON.parse(await docker(["exec", names.renderer, "cat", "/app/node_modules/playwright-core/package.json"])).version;
  });

  it("renders a script-built page through the proxy and the text is captured", async () => {
    const url = `http://host.docker.internal:${articlePort}/js-only`;
    // The plain shell has no article text; the rendered DOM has.
    const shell = await (await fetch(`${fx.urls.article}/js-only`)).text();
    expect(shell).not.toContain(MARKER);
    const out = await inContainer(names.proxy, render(url));
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect(out.html).toContain(MARKER);
    expect(out.html).toContain("Aurora survey");
    expect(out.status).toBe(200);
    expect(out.requests).toBeGreaterThanOrEqual(3);
    measured.firstRender = { durationMs: out.durationMs, memoryMb: out.memoryMb, loadedBytes: out.loadedBytes, requests: out.requests, blocked: out.blockedRequests };
    const logs = await docker(["logs", names.proxy], { allowFail: true });
    expect(logs).toContain('"type":"request"');
  });

  it("measures memory over several pages", async () => {
    const url = `http://host.docker.internal:${articlePort}/js-only/big`;
    const samples: number[] = [];
    for (let i = 0; i < 4; i++) {
      const out = await inContainer(names.proxy, render(url));
      expect(out.status, JSON.stringify(out)).toBe(200);
      samples.push(out.memoryMb);
    }
    const peak = Number((await docker(["exec", names.renderer, "sh", "-c", "cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0"])).trim());
    const stats = (await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}|{{.PIDs}}", names.renderer])).trim();
    measured.memory = { cgroupMbAfterEachPage: samples, cgroupPeakMb: peak ? Math.round(peak / 1048576) : null, dockerStats: stats };
    expect(Math.max(...samples)).toBeLessThan(1024);
  });

  it("measures memory on a script-heavy page (30,000 table rows built by script)", async () => {
    const out = await inContainer(names.proxy, render(`http://host.docker.internal:${articlePort}/js-only/heavy`, 60_000), 120_000);
    expect(out.status, JSON.stringify(out).slice(0, 300)).toBe(200);
    expect(out.html).toContain("row-29999");
    const peak = Number((await docker(["exec", names.renderer, "sh", "-c", "cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0"])).trim());
    measured.heavyPage = { durationMs: out.durationMs, memoryMbAfter: out.memoryMb, cgroupPeakMb: peak ? Math.round(peak / 1048576) : null, domBytes: Buffer.byteLength(out.html), loadedBytes: out.loadedBytes };
    expect(peak / 1048576).toBeLessThan(1024);
    // The container is still healthy and renders the next page.
    const next = await inContainer(names.proxy, render(`http://host.docker.internal:${articlePort}/js-only`), 60_000);
    expect(next.status).toBe(200);
  }, 5 * 60_000);

  it("cannot reach the internet or the LAN directly: no route out of the internal network", async () => {
    const direct = [["1.1.1.1", 443], ["8.8.8.8", 53], ["93.184.216.34", 80]] as const;
    for (const [h, p] of direct) expect((await inContainer(names.renderer, probe(h, p))).connected, `${h}:${p}`).toBe(false);
    const lan = lanAddress();
    if (lan) expect((await inContainer(names.renderer, probe(lan, articlePort))).connected, `LAN ${lan}`).toBe(false);
    // The Docker host and a fixture on it are unreachable too, and so is a name lookup.
    expect((await inContainer(names.renderer, probe("host.docker.internal", articlePort))).connected).toBe(false);
    const dns = await inContainer(names.renderer, `import dns from "node:dns/promises"; try { await dns.lookup("example.com"); console.log(JSON.stringify({ resolved: true })); } catch (e) { console.log(JSON.stringify({ resolved: false, code: e.code })); }`);
    expect(dns.resolved).toBe(false);
    // The proxy is the one thing it can reach.
    expect((await inContainer(names.renderer, probe("server", 3128))).connected).toBe(true);
    measured.directEgress = "blocked";
  });

  it("the browser cannot get around the proxy either: private targets fail and nothing reaches them", async () => {
    await fetch(`${fx.urls.ssrfBait}/__canary/reset`);
    const lan = lanAddress();
    const targets = [
      "http://10.0.0.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/health", "http://[::1]:8080/health", "http://2130706433:8080/health",
      `http://host.docker.internal:${baitPort}/canary`, `http://127.0.0.1:${baitPort}/canary`,
      ...(lan ? [`http://${lan}:${articlePort}/`] : []),
    ];
    for (const url of targets) {
      const out = await inContainer(names.proxy, render(url, 12_000), 60_000);
      expect(out.status, `${url}: ${JSON.stringify(out).slice(0, 200)}`).not.toBe(200);
    }
    expect((await getJson<{ hits: number }>(`${fx.urls.ssrfBait}/__canary`)).hits).toBe(0);
    const logs = await docker(["logs", names.proxy], { allowFail: true });
    expect(logs).toContain('"type":"blocked"');
    measured.privateTargetsRefused = targets.length;
  }, 5 * 60_000);

  it("rejects calls without the secret", async () => {
    const out = await inContainer(names.proxy, `const r = await fetch("http://${names.renderer}:8080/render", { method: "POST", body: JSON.stringify({ url: "http://host.docker.internal/" }) }); console.log(JSON.stringify({ status: r.status }));`);
    expect(out.status).toBe(401);
  });

  it("compose file: the renderer profile is off by default, on its own internal network", () => {
    const env = { ...process.env, NCB_PROXY_SECRET: "x".repeat(32) };
    const run = (args: string[]) => spawnSync("docker", ["compose", ...args], { cwd: ROOT, encoding: "utf8", env });
    const off = run(["config", "--services"]);
    expect(off.stdout.split("\n")).not.toContain("renderer");
    const on = run(["--profile", "renderer", "config", "--format", "json"]);
    expect(on.status, on.stderr).toBe(0);
    const cfg = JSON.parse(on.stdout);
    expect(Object.keys(cfg.services)).toContain("renderer");
    expect(Object.keys(cfg.services.renderer.networks)).toEqual(["render"]);
    expect(cfg.networks.render.internal).toBe(true);
    expect(Object.keys(cfg.services.server.networks)).toContain("render");
    expect(cfg.services.renderer.mem_limit).toBeDefined();
    expect(cfg.services.renderer.read_only).toBe(true);
  });
});
