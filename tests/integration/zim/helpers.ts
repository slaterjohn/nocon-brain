import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBrowserServer, type BrowserTest } from "../browser/helpers.js";
import type { StartOptions } from "../server/helpers.js";
import { buildFixtures } from "../../fixtures/zim/build.mjs";

export * from "../../fixtures/zim/build.mjs";

type Fixtures = Awaited<ReturnType<typeof buildFixtures>>;
let built: Promise<Fixtures> | undefined;

/** The fixture ZIMs, generated once per machine with the libzim Creator (tests/fixtures/zim/build.mjs) into a cache under the temp folder. */
export function fixtureZims(): Promise<Fixtures> {
  built ??= buildFixtures(path.join(os.tmpdir(), "ncb-zim-fixtures-v1"));
  return built;
}

export interface ZimTest extends BrowserTest {
  /** Copies a fixture into an allowed folder and returns the new path (so the same fixture can be added twice under different names). */
  place(kind: keyof Fixtures, name?: string): Promise<string>;
  add(kind: keyof Fixtures, body?: Record<string, unknown>, name?: string): Promise<{ status: number; body: any }>;
}

export async function startZimServer(opts: StartOptions & { allow?: string; zim?: Record<string, unknown> } = {}): Promise<ZimTest> {
  const t = await startBrowserServer({ ...opts, server: { ...(opts.server ?? {}), zim: { testHooks: true, hangGraceMs: 400, ...(opts.zim ?? {}) } } as never });
  const lib = path.join(t.rootsDir, "library");
  fs.mkdirSync(lib, { recursive: true });
  const place = async (kind: keyof Fixtures, name?: string) => {
    const src = (await fixtureZims())[kind];
    const dst = path.join(lib, name ?? path.basename(src));
    fs.copyFileSync(src, dst);
    return dst;
  };
  const add = async (kind: keyof Fixtures, body: Record<string, unknown> = {}, name?: string) => {
    const p = await place(kind, name);
    return t.api("POST", "/api/zim/packages/import", { path: p, ...body });
  };
  return Object.assign(t, { place, add }) as ZimTest;
}

/** Total bytes of all regular files under the given folders (a measure of what a test wrote). */
export function folderBytes(...dirs: string[]): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) n += fs.statSync(p).size;
    }
  };
  for (const d of dirs) if (fs.existsSync(d)) walk(d);
  return n;
}
