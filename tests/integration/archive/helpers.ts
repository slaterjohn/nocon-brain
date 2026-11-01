import type http from "node:http";
import { afterEach } from "vitest";
import { FakeClock } from "@ncb/shared";
import { ArchiveTokenService, MemoryCaptureStore, createArchiveListener, type ArchiveListener, type ArchiveListenerOptions } from "@ncb/server";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});
export function onCleanup(fn: () => Promise<void> | void): void {
  closers.push(fn);
}

export interface Harness {
  listener: ArchiveListener;
  store: MemoryCaptureStore;
  tokens: ArchiveTokenService;
  clock: FakeClock;
  port: number;
  origin: string;
  appOrigin: string;
  mint(frameId?: string): string;
  get(path: string, init?: RequestInit): Promise<Response>;
  /** `/a/{token}` + path */
  url(path: string, frameId?: string): string;
}

export async function startListener(opts: Partial<ArchiveListenerOptions> & { appOrigin?: string; host?: string } = {}): Promise<Harness> {
  const clock = new FakeClock();
  const store = (opts.store as MemoryCaptureStore | undefined) ?? new MemoryCaptureStore();
  const tokens = new ArchiveTokenService({ secret: Buffer.alloc(32, 3), clock });
  const appOrigin = opts.appOrigin ?? "http://localhost:3000";
  const listener = createArchiveListener({ appUrl: appOrigin, clock, tokens, store, ...opts });
  const server: http.Server = listener.server;
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((r) => server.listen(0, host, () => r()));
  onCleanup(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port;
  const origin = `http://${host}:${port}`;
  const mint = (frameId = "fr_test") => tokens.mint({ userId: "u1", frameId, appOrigin });
  return {
    listener, store, tokens, clock, port, origin, appOrigin, mint,
    url: (p, f) => `${origin}/a/${mint(f)}${p}`,
    get: (p, init) => fetch(`${origin}${p}`, { redirect: "manual", ...init }),
  };
}
