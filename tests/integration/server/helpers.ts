import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { FakeClock, loadConfig, type Clock, type ResolvedConfig } from "@ncb/shared";
import { createServer, type NcbServer, type Services, type ServerOptions } from "@ncb/server";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/server");

let workerBundle: string | undefined;
/** Bundles src/worker.ts to plain JS once per test file, so worker threads need no TypeScript loader. */
export function workerFile(): string {
  if (workerBundle) return workerBundle;
  const req = createRequire(path.join(serverDir, "package.json"));
  const esbuild = req("esbuild") as { buildSync(o: Record<string, unknown>): unknown };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncb-worker-"));
  workerBundle = path.join(dir, "worker.mjs");
  esbuild.buildSync({
    entryPoints: [path.join(serverDir, "src/worker.ts")],
    outfile: workerBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  return workerBundle;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

export function tempDir(prefix = "ncb-srv-"): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

export const APP_URL = "http://localhost:3000";
export const PROXY_SECRET = "p".repeat(32);

export interface TestServer {
  server: NcbServer;
  svc: Services;
  clock: Clock;
  fake: FakeClock;
  config: ResolvedConfig;
  dataDir: string;
  /** An allowed root containing `vol/`, a ready-made empty folder to register as a volume. */
  rootsDir: string;
  volDir: string;
  logs: string[];
}

export interface StartOptions {
  env?: Record<string, string>;
  server?: Partial<ServerOptions>;
  /** Skip `initialize()` so a test can look at the `starting` phase. */
  deferInit?: boolean;
  dataDir?: string;
  rootsDir?: string;
}

export async function startServer(opts: StartOptions = {}): Promise<Omit<TestServer, "svc"> & { svc: Services }> {
  const dataDir = opts.dataDir ?? tempDir("ncb-data-");
  const rootsDir = opts.rootsDir ?? tempDir("ncb-roots-");
  const volDir = path.join(rootsDir, "vol");
  fs.mkdirSync(volDir, { recursive: true });
  const config = loadConfig({
    NCB_DATA_DIR: dataDir,
    NCB_VOLUMES_ALLOWED_ROOTS: rootsDir,
    NCB_APP_URL: APP_URL,
    NCB_PROXY_SECRET: PROXY_SECRET,
    NCB_LOG_LEVEL: "fatal",
    NCB_EXTRACT_WORKERS: "0",
    NCB_MIN_FREE_DISK_GB: "0",
    NCB_API_HOST: "127.0.0.1",
    NCB_ARCHIVE_HOST: "127.0.0.1",
    ...(opts.env ?? {}),
  } as NodeJS.ProcessEnv);
  const fake = new FakeClock();
  const logs: string[] = [];
  // Port 0 (any free port) is not a valid NCB_*_PORT value, so it is set after validation.
  const server = await createServer({
    config: { ...config, NCB_API_PORT: 0, NCB_ARCHIVE_PORT: 0 },
    clock: fake,
    workerFile: workerFile(),
    runnerPollMs: 25,
    archive: false,
    logStream: { write: (s: string) => { logs.push(s); return true; } } as never,
    ...(opts.server ?? {}),
  });
  cleanups.push(() => server.close());
  const svc = opts.deferInit ? (undefined as unknown as Services) : await server.initialize();
  return { server, svc, clock: fake, fake, config, dataDir, rootsDir, volDir, logs };
}

export interface Req {
  method?: string;
  url: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
  /** Omit the CSRF header and Origin (default adds both to non-GET requests). */
  raw?: boolean;
  remoteAddress?: string;
}

export async function call(t: { server: NcbServer }, r: Req): Promise<LightMyRequestResponse & { json<T = any>(): T }> {
  const method = (r.method ?? (r.body !== undefined ? "POST" : "GET")) as "GET";
  const headers: Record<string, string> = { ...(r.headers ?? {}) };
  if (!r.raw && method !== "GET") {
    headers["x-nocon-csrf"] = "1";
    headers.origin = APP_URL;
  }
  if (r.cookie) headers.cookie = r.cookie;
  if (r.body !== undefined) headers["content-type"] = "application/json";
  return t.server.app.inject({
    method,
    url: r.url,
    headers,
    payload: r.body !== undefined ? JSON.stringify(r.body) : undefined,
    ...(r.remoteAddress ? { remoteAddress: r.remoteAddress } : {}),
  }) as never;
}

type LightMyRequestResponse = Awaited<ReturnType<NcbServer["app"]["inject"]>>;

export function cookieFrom(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x: { name: string }) => x.name === "ncb_session");
  if (!c) throw new Error("no ncb_session cookie in response");
  return `ncb_session=${c.value}`;
}

export const ADMIN = { username: "admin", password: "correct horse battery" };

/** Creates the admin through the real endpoint and returns the session cookie. */
export async function setupAdmin(t: { server: NcbServer }, creds = ADMIN): Promise<string> {
  const res = await call(t, { url: "/api/setup/admin", body: creds });
  if (res.statusCode !== 200) throw new Error(`setup/admin failed: ${res.statusCode} ${res.body}`);
  return cookieFrom(res);
}
