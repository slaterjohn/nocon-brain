import http from "node:http";
import type { AddressInfo } from "node:net";
import { startFixtures as start } from "../../fixtures/sites/index.mjs";

export interface Fixtures {
  urls: Record<string, string>;
  close(): Promise<void>;
  log(name: string): Promise<unknown> | unknown;
}

export async function startFixtures(opts: Record<string, unknown> = {}): Promise<Fixtures> {
  return (await start(opts)) as Fixtures;
}

export async function getJson<T = any>(url: string): Promise<T> {
  return (await fetch(url)).json() as Promise<T>;
}

/** A tiny scripted HTTP server on 127.0.0.1 for header, cookie and robots edge cases. */
export async function localServer(handler: http.RequestListener): Promise<{ url: string; port: number; requests: http.IncomingMessage[]; close(): Promise<void> }> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
