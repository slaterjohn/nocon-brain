import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import { describeComponent, score, type ScoreComponent, type Signals } from "./scoring.js";
import type { DiscoverySettings } from "./settings.js";

export interface ScorerDeps {
  db: Db;
  clock: Clock;
  discovery(): DiscoverySettings;
  /** 0 (plenty of room) to 1 (none). */
  storagePressure(): number;
  /** Expected bytes for a download linked to a source (or none). */
  estimateBytes(sourceId: number | null): number;
}

interface CandRow {
  id: number; public_id: string; url_key: string; last_seen_at: number; est_bytes: number | null; origin_storage: string | null; suggested_source_id: number | null;
}

export interface Explanation {
  score: number;
  /** True when the components were stored with the score; false when they are worked out now (providers that allow no storage keep none). */
  stored: boolean;
  components: (ScoreComponent & { label: string; explanation: string })[];
  summary: string[];
  signals: Signals;
}

const LABELS: Record<ScoreComponent["name"], string> = {
  inboundArchivedLinks: "Saved pages that link to it",
  collectionRelevance: "Linked from your collections",
  searchFrequency: "Search frequency",
  bookmarks: "Bookmarks",
  recentActivity: "Recent activity",
  sourcePriority: "Source priority",
  estimatedCost: "Estimated download size",
  storageHeadroom: "Storage headroom",
};

/**
 * Computes the signals of a candidate from the database and scores them (task D-03). The score and its components are written to
 * the candidate row, except for candidates from a provider whose storage policy allows no components to be kept (the database refuses
 * them): those are worked out again whenever they are asked for, from the same stored facts.
 */
export class Scorer {
  constructor(private readonly o: ScorerDeps) {}
  private get db(): Db { return this.o.db; }

  signals(c: CandRow): Signals {
    const d = this.o.discovery();
    const linkers = this.db.all<{ page_id: number }>(
      `SELECT DISTINCT l.from_page_id AS page_id FROM links l JOIN pages p ON p.id = l.from_page_id WHERE l.to_url_key = ? AND p.deleted_at IS NULL AND p.availability IN ('archived','partial') AND l.rel_nofollow = 0`, [c.url_key]);
    const ids = linkers.map((l) => l.page_id);
    const marks = ids.length ? ids.map(() => "?").join(",") : "NULL";
    const inCollections = ids.length ? this.db.get<{ n: number }>(`SELECT COUNT(DISTINCT page_id) AS n FROM collection_memberships WHERE page_id IN (${marks})`, ids)!.n : 0;
    const bookmarks = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bookmarks WHERE deleted_at IS NULL AND (url_key = ?${ids.length ? ` OR page_id IN (${marks})` : ""})`, [c.url_key, ...ids])!.n;
    const searchOn = d.searchDriven.searchesInfluenceDiscovery && d.searchDriven.prioritiseFrequentTopics;
    const searchDays = searchOn
      ? this.db.get<{ n: number }>("SELECT COUNT(DISTINCT seen_at / 86400000) AS n FROM candidate_provenance WHERE candidate_id = ? AND kind = 'search_result'", [c.id])!.n
      : 0;
    const prio = this.db.get<{ p: number | null }>(
      `SELECT MIN(s.priority) AS p FROM sources s WHERE s.deleted_at IS NULL AND (
         s.id IN (SELECT source_id FROM page_sources WHERE page_id IN (${marks}))
         OR s.id IN (SELECT ref_source_id FROM candidate_provenance WHERE candidate_id = ? AND ref_source_id IS NOT NULL))`, [...ids, c.id])!.p;
    return {
      inboundArchivedLinks: ids.length,
      linkingPagesInCollections: inCollections,
      searchDays,
      bookmarkHits: bookmarks,
      sinceSeenMs: Math.max(0, this.o.clock.now() - c.last_seen_at),
      bestSourcePriority: prio,
      estimatedBytes: c.est_bytes ?? this.o.estimateBytes(c.suggested_source_id),
      storagePressure: this.o.storagePressure(),
    };
  }

  private row(idOrPublic: number | string): CandRow | undefined {
    return this.db.get<CandRow>(
      `SELECT id, public_id, url_key, last_seen_at, est_bytes, origin_storage, suggested_source_id FROM discovery_candidates WHERE ${typeof idOrPublic === "number" ? "id" : "public_id"} = ?`, [idOrPublic]);
  }

  /** Scores one candidate and stores the result. Returns the score, or undefined when the candidate is gone. */
  scoreOne(id: number): number | undefined {
    const c = this.row(id);
    if (!c) return undefined;
    const sig = this.signals(c);
    const res = score(sig, this.o.discovery().weights);
    const keepsComponents = c.origin_storage === null || c.origin_storage === "unrestricted";
    this.db.run(
      "UPDATE discovery_candidates SET score = ?, score_components_json = ?, est_bytes = COALESCE(est_bytes, ?), scored_at = ? WHERE id = ?",
      [res.score, keepsComponents ? JSON.stringify(res.components) : null, sig.estimatedBytes, this.o.clock.now(), id]);
    return res.score;
  }

  /** Re-scores every candidate that can still be chosen (new or approved), at most `limit` of them, oldest score first. */
  rescore(limit = 2000): number {
    const ids = this.db.all<{ id: number }>("SELECT id FROM discovery_candidates WHERE state IN ('new','approved') ORDER BY COALESCE(scored_at, 0), id LIMIT ?", [limit]);
    for (const { id } of ids) this.scoreOne(id);
    return ids.length;
  }

  /** The "why was this suggested?" breakdown. Always worked out from the current settings; the components add up to the score. */
  explain(idOrPublic: number | string): Explanation | undefined {
    const c = this.row(idOrPublic);
    if (!c) return undefined;
    const sig = this.signals(c);
    const res = score(sig, this.o.discovery().weights);
    const components = res.components.map((x) => ({ ...x, label: LABELS[x.name], explanation: describeComponent(x, sig) }));
    const summary = components.filter((x) => x.raw > 0).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).map((x) => x.explanation);
    return { score: res.score, stored: c.origin_storage === null || c.origin_storage === "unrestricted", components, summary, signals: sig };
  }
}
