import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockApi } from "./mock-api";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_PORT = 25000;
const API_PORT = 25001;
const ARCHIVE_PORT = 25002;

async function waitFor(url: string, ms: number, label: string) {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label} did not become healthy (${url}): ${last}`);
}

/**
 * Starts the stack for the suite.
 * - Default: builds and starts apps/server (dist/index.js) plus the built web app.
 * - E2E_MOCK_API=1: a mock of docs/api.md (tests/e2e/mock-api.ts) instead of the server.
 *   The same specs run against both; the first spec creates the administrator through the wizard.
 */
export default async function globalSetup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ncb-e2e-"));
  const volumes = path.join(tmp, "volumes");
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(path.join(volumes, "main"), { recursive: true });
  fs.mkdirSync(path.join(volumes, "container-fs"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const proxySecret = crypto.randomBytes(24).toString("hex");
  const real = process.env.E2E_MOCK_API !== "1";
  process.env.E2E_MODE = real ? "real-server" : "mock-api";
  process.env.E2E_VOLUMES_ROOT = volumes;
  process.env.E2E_API_URL = `http://127.0.0.1:${API_PORT}`;
  process.env.E2E_PROXY_SECRET = proxySecret;

  const procs: ChildProcess[] = [];
  const closers: (() => Promise<void>)[] = [];
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncb-e2e-logs-"));
  console.log(`e2e mode: ${process.env.E2E_MODE}; logs in ${logDir}`);

  const start = (name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
    const out = fs.openSync(path.join(logDir, `${name}.log`), "a");
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: true });
    procs.push(p);
    return p;
  };

  const teardown = async () => {
    for (const p of procs) {
      try {
        if (p.pid) process.kill(-p.pid, "SIGTERM");
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 800));
    for (const p of procs) {
      try {
        if (p.pid) process.kill(-p.pid, "SIGKILL");
      } catch {}
    }
    for (const c of closers) await c().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    if (real) {
      if (!fs.existsSync(path.join(ROOT, "apps/server/package.json"))) throw new Error("apps/server does not exist.");
      execFileSync("pnpm", ["--filter", "@ncb/server", "build"], { cwd: ROOT, stdio: "inherit" });
      start("server", process.execPath, ["apps/server/dist/index.js"], {
        NODE_ENV: "production",
        NCB_APP_URL: `http://127.0.0.1:${WEB_PORT}`,
        NCB_API_HOST: "127.0.0.1",
        NCB_API_PORT: String(API_PORT),
        NCB_ARCHIVE_HOST: "127.0.0.1",
        NCB_ARCHIVE_PORT: String(ARCHIVE_PORT),
        NCB_DATA_DIR: dataDir,
        NCB_VOLUMES_ALLOWED_ROOTS: volumes,
        NCB_PROXY_SECRET: proxySecret,
        NCB_SECRET_KEY: crypto.randomBytes(24).toString("hex"),
        NCB_LOG_LEVEL: "warn",
        NCB_MIN_FREE_DISK_GB: "0",
      });
      await waitFor(`http://127.0.0.1:${API_PORT}/api/system/health`, 60_000, "server");
    } else {
      const mock = await startMockApi({ port: API_PORT, proxySecret, allowedRoot: volumes });
      closers.push(mock.close);
    }

    // Private build directory so a concurrent build of apps/web elsewhere cannot corrupt the served bundle.
    const webEnv = { NEXT_DIST_DIR: ".next-e2e" };
    if (process.env.E2E_REBUILD || !fs.existsSync(path.join(ROOT, "apps/web/.next-e2e/BUILD_ID"))) {
      execFileSync("pnpm", ["--filter", "@ncb/web", "build"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...webEnv } });
    }
    start("web", "pnpm", ["--filter", "@ncb/web", "exec", "next", "start", "-p", String(WEB_PORT), "-H", "127.0.0.1"], {
      ...webEnv,
      NODE_ENV: "production",
      API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
      NCB_PROXY_SECRET: proxySecret,
    });
    await waitFor(`http://127.0.0.1:${WEB_PORT}/healthz`, 60_000, "web");
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
