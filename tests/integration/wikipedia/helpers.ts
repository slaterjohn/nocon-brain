import { afterEach } from "vitest";
import { systemClock } from "@ncb/shared";
import type { ServerOptions } from "@ncb/server";
import { startWikipedia } from "../../fixtures/sites/wikipedia.mjs";
import { startZimServer, type ZimTest } from "../zim/helpers.js";
import { until } from "../browser/helpers.js";

export { until };

/** A contact for the tests: a web address, never an email address. */
export const CONTACT = "https://github.com/slaterjohn/nocon-brain";

export type FakeWiki = Awaited<ReturnType<typeof startWikipedia>>;
interface LogEntry { n: number; method: string; url: string; ua: string | null; t: number; inFlight: number }

const fakes: FakeWiki[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

/** The fake Wikimedia server (core REST and Action API, UA policy, rate limit, maxlag). Closed after each test. */
export async function startFakeWiki(rps = 50): Promise<FakeWiki> {
  const f = await startWikipedia({ rps });
  fakes.push(f);
  return f;
}

export async function fakeLog(f: FakeWiki): Promise<{ entries: LogEntry[]; maxInFlight: number; total: number }> {
  return (await fetch(`${f.origin}/__log`)).json() as never;
}
export const fakeControl = async (f: FakeWiki, q: string) => (await fetch(`${f.origin}/__control?${q}`)).json() as Promise<Record<string, unknown>>;

/** Requests the fake saw for pages and the Action API (not its own log and control paths). */
export const apiRequests = (log: { entries: LogEntry[] }): LogEntry[] => log.entries.filter((e) => /^\/w\//.test(e.url));
export const pageRequests = (log: { entries: LogEntry[] }): string[] =>
  log.entries.map((e) => /^\/w\/rest\.php\/v1\/page\/([^/]+)\/html/.exec(e.url)?.[1]).filter((x): x is string => !!x).map(decodeURIComponent);

export interface WikiTest extends ZimTest {
  /** The fake Wikimedia server. */
  wiki: FakeWiki;
  contact: string | null;
}

/**
 * A full server (archive listener, knowledge packages) whose Wikipedia client talks to a local fake Wikimedia server. The pace is shortened
 * (250 ms between requests) so a crawl of a few pages does not take minutes; the rate test uses the real one-second pace on its own.
 */
export async function startWikiServer(o: {
  contact?: string | null;
  rps?: number;
  wiki?: ServerOptions["wikipedia"];
  env?: Record<string, string>;
  /** Do not point the client at the fake server (the test supplies its own `wiki.fetch`). */
  noOrigin?: boolean;
} = {}): Promise<WikiTest> {
  const fake = await startFakeWiki(o.rps ?? 50);
  const contact = o.contact === undefined ? CONTACT : o.contact;
  const t = await startZimServer({
    env: { NCB_EXTRACT_WORKERS: "0", ...(contact ? { NCB_CONTACT: contact } : {}), ...(o.env ?? {}) },
    server: { clock: systemClock, runnerPollMs: 15, wikipedia: { ...(o.noOrigin ? {} : { origin: fake.origin }), minIntervalMs: 250, minBackoffMs: 100, maxInlineWaitMs: 3000, ...(o.wiki ?? {}) } },
  });
  return Object.assign(t, { wiki: fake, contact }) as WikiTest;
}

export async function waitCrawl(t: WikiTest, downloadId: string, ms = 60_000) {
  return until(() => {
    const s = t.svc.crawl.get(downloadId);
    return s && s.finishedAt !== null ? s : undefined;
  }, ms);
}

/** The jobs that fetch image credits have all finished. */
export async function creditsDone(t: WikiTest, ms = 30_000) {
  await until(() => t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'wikipedia_fetch' AND state IN ('queued','running','held')")!.n === 0, ms);
}
