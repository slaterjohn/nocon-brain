import { createFetcher, createSsrfGuard } from "@ncb/fetch";
import { newId } from "@ncb/shared";
import type { PipelineFetcher } from "../../apps/server/src/pipeline/types.js";
import { startStorageTest, type StorageTest } from "../storage-safety/helpers.js";
import type { StartOptions } from "../integration/server/helpers.js";
import { until } from "../integration/browser/helpers.js";

export { until };
export { useFixtures } from "../integration/pipeline/helpers.js";
export type { StorageTest };

/** Slugs of the article fixture site (tests/fixtures/sites/README.md): thirty-odd distinct, fast, local pages. */
export const SLUGS = [
  "astronomy", "solar-system", "black-holes", "planets", "stars", "galaxies", "comets", "telescopes", "exoplanets", "moon", "mars", "jupiter",
  "renewable-energy", "solar-power", "wind-power", "hydropower", "geothermal-energy", "biomass", "energy-storage", "power-grid",
  "bread-baking", "coffee-brewing", "urban-gardening", "medieval-castles", "tide-pools",
];

/**
 * The capture fetcher of a discovery test. It records every address the pipeline fetches. While `hold` is true a fetch waits (so a
 * download stays "running" and nothing finishes behind the test's back); `release()` lets them through to the real fetcher.
 */
export class TestFetcher implements PipelineFetcher {
  readonly calls: string[] = [];
  private open: () => void = () => undefined;
  private gate: Promise<void>;
  private holding: boolean;
  private readonly real = createFetcher({ userAgent: "ncb-test", ssrf: createSsrfGuard({ allow: "127.0.0.1" }) }) as unknown as PipelineFetcher;

  constructor(hold = false) {
    this.holding = hold;
    this.gate = hold ? new Promise<void>((r) => { this.open = r; }) : Promise.resolve();
  }

  release(): void {
    this.holding = false;
    this.open();
  }

  async fetch(url: string, o?: Parameters<PipelineFetcher["fetch"]>[1]): ReturnType<PipelineFetcher["fetch"]> {
    this.calls.push(url);
    if (this.holding) {
      await new Promise<void>((resolve, reject) => {
        void this.gate.then(resolve);
        o?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return this.real.fetch(url, o);
  }
}

export interface DiscoveryTest extends StorageTest {
  fetcher: TestFetcher;
  /** Switches discovery settings through the API (merges). */
  settings(patch: Record<string, unknown>): Promise<{ status: number; body: any }>;
}

export async function startDiscoveryTest(opts: StartOptions & { hold?: boolean; signIn?: boolean; quotaBytes?: number; reserveFreeBytes?: number } = {}): Promise<DiscoveryTest> {
  const fetcher = new TestFetcher(opts.hold ?? false);
  const { hold: _hold, ...rest } = opts;
  void _hold;
  const t = await startStorageTest({ ...rest, server: { captureFetcher: fetcher, discovery: { tickMs: 0 }, ...(rest.server ?? {}) } });
  return Object.assign(t, {
    fetcher,
    settings: (patch: Record<string, unknown>) => t.api("PUT", "/api/discovery/settings", patch),
  }) as DiscoveryTest;
}

export interface FloodOpts {
  /** Candidates to insert. */
  urls: string[];
  depth?: number;
  state?: "new" | "approved";
  score?: number;
  /** A page (internal id) whose link produced the candidates, for scope. */
  refPageId?: number;
  kind?: "link" | "search_result" | "visit" | "bookmark" | "missing_link" | "saved_search" | "manual";
  estBytes?: number | null;
}

/** Inserts candidates straight into the table, so a limit is tested without the store's own checks in front of it. Returns their row ids. */
export function flood(t: StorageTest, o: FloodOpts): number[] {
  const { db, clock } = t.svc;
  const now = clock.now();
  return o.urls.map((url) => {
    const u = new URL(url);
    const r = db.run(
      `INSERT INTO discovery_candidates (public_id, url, url_key, host, depth, state, score, est_bytes, first_seen_at, last_seen_at, expires_at, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("cand"), url, t.svc.pipeline.urlKey(url), u.hostname, o.depth ?? 1, o.state ?? "new", o.score ?? 50, o.estBytes ?? null, now, now, now + 30 * 86_400_000,
        o.state === "approved" ? "user" : null, o.state === "approved" ? now : null]);
    const id = Number(r.lastInsertRowid);
    db.run("INSERT INTO candidate_provenance (candidate_id, kind, ref_page_id, seen_at) VALUES (?, ?, ?, ?)", [id, o.kind ?? "link", o.refPageId ?? null, now]);
    return id;
  });
}

export const articleUrls = (origin: string, n = SLUGS.length): string[] => SLUGS.slice(0, n).map((s) => `${origin}/${s}`);

/** Downloads the runner started (requested_by discovery), however far they got. */
export function discoveryDownloads(t: StorageTest): { id: number; state: string; requested_url: string }[] {
  return t.svc.db.all("SELECT id, state, requested_url FROM download_jobs WHERE requested_by = 'discovery' ORDER BY id");
}

/** A saved page that belongs to a source, so links "from" it are in that source's scope. Returns { pageId, sourceId (row), sourcePublicId }. */
export async function seedSourcePage(t: StorageTest, url = "https://seed.example/home", priority: 1 | 2 | 3 | 4 = 2) {
  const sourceId = t.seed.source({ priority, name: `Seed ${priority}` });
  const page = await t.seed.page({ url, sources: [sourceId] });
  const sourcePublicId = t.svc.db.get<{ p: string }>("SELECT public_id AS p FROM sources WHERE id = ?", [sourceId])!.p;
  return { pageId: page.pageId, pagePublicId: page.publicId, sourceId, sourcePublicId };
}

/** Automatic mode with room to move; `active` and `top` override single keys. */
export function automatic(sourcePublicId: string, active: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    passive: { fromLinks: true },
    active: {
      mode: "automatic", allowedSourceIds: [sourcePublicId], maxCandidatesPerRun: 50, maxDepth: 3, maxQueued: 100, maxRequestsPerDay: 200, maxBytesPerDay: 400 * 1024 * 1024,
      perSiteDailyCap: 200, minScore: 0, respectSchedule: false, ...active,
    },
    ceilings: { maxDepth: 3, maxQueued: 100, maxRequestsPerDay: 200, maxBytesPerDay: 512 * 1024 * 1024 },
    acknowledged: true,
    ...top,
  };
}
