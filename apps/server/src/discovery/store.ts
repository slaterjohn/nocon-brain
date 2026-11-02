import type { Db } from "@ncb/db";
import { newId, type Clock } from "@ncb/shared";
import { effectiveLimits, type DiscoverySettings } from "./settings.js";
import type { ResourceProfile } from "@ncb/crawl";

export type ProvenanceKind = "link" | "search_result" | "saved_search" | "visit" | "bookmark" | "missing_link" | "manual";
export type CandidateState = "new" | "approved" | "queued" | "archived" | "dismissed" | "expired";
export type StorageKind = "none" | "ttl" | "unrestricted";

export interface AddInput {
  url: string;
  kind: ProvenanceKind;
  /** Hops from a page the Human saved: 1 for a link on such a page. */
  depth: number;
  refPageId?: number;
  refSourceId?: number;
  refSearchId?: number;
  /** A short machine-made note (for a link, the region of the page it was in). Never text from a search provider. */
  detail?: string;
  weight?: number;
  suggestedSourceId?: number;
  originStorage?: StorageKind;
  expiresAt?: number;
  estBytes?: number;
}

export type SkipReason = "invalid_url" | "sensitive" | "archived" | "in_progress" | "excluded" | "dismissed" | "depth" | "pool_full" | "off";
export type AddResult = { outcome: "created" | "updated"; id: number } | { outcome: "skipped"; reason: SkipReason };

const SENSITIVE_PARAM = /(^|[_-])(token|key|apikey|reset|session|sessionid|sid|auth|password|passwd|secret|signature|sig|otp|jwt)([_-]|$)/i;
const SENSITIVE_PATH = /(^|\/)(logout|log-out|login|log-in|signin|sign-in|signout|sign-out|unsubscribe|password|reset|verify|confirm|activate|oauth|auth)(\/|$|\.)/i;

/** Addresses that are likely to carry a secret or to change something when opened (docs/risk-register.md R-38). */
export function isSensitiveUrl(u: URL): boolean {
  if (SENSITIVE_PATH.test(u.pathname)) return true;
  for (const name of u.searchParams.keys()) if (SENSITIVE_PARAM.test(name)) return true;
  return false;
}

export interface StoreDeps {
  db: Db;
  clock: Clock;
  urlKey(url: string): string;
  discovery(): DiscoverySettings;
  profile(): ResourceProfile;
  /** Called after a candidate was created or gained a reason, so its score can be refreshed. */
  changed?(id: number): void;
}

/**
 * The candidate store (task D-01): normalisation, de-duplication, provenance and expiry. One row per address (`url_key`), one
 * provenance row per reason per day. An address that is already archived, being downloaded, excluded or dismissed produces no
 * candidate. Nothing here touches the network.
 */
export class CandidateStore {
  constructor(private readonly o: StoreDeps) {}
  private get db(): Db { return this.o.db; }

  add(input: AddInput): AddResult {
    const { db, clock } = this.o;
    let u: URL;
    let key: string;
    try {
      u = new URL(input.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return { outcome: "skipped", reason: "invalid_url" };
      if (u.username || u.password) return { outcome: "skipped", reason: "invalid_url" };
      u.hash = "";
      key = this.o.urlKey(u.href);
    } catch {
      return { outcome: "skipped", reason: "invalid_url" };
    }
    if (isSensitiveUrl(u)) return { outcome: "skipped", reason: "sensitive" };
    const limits = effectiveLimits(this.o.discovery(), this.o.profile());
    if (input.depth > limits.maxDepth) return { outcome: "skipped", reason: "depth" };
    if (this.isArchived(key)) return { outcome: "skipped", reason: "archived" };
    if (db.get("SELECT 1 AS x FROM jobs WHERE url_key = ? AND state IN ('queued','running','held') AND type = 'fetch'", [key])) return { outcome: "skipped", reason: "in_progress" };
    if (db.get("SELECT 1 AS x FROM url_exclusions WHERE url_key = ?", [key])) return { outcome: "skipped", reason: "excluded" };

    const now = clock.now();
    const host = u.hostname.toLowerCase();
    const existing = db.get<{ id: number; state: CandidateState; depth: number; origin_storage: StorageKind | null }>("SELECT id, state, depth, origin_storage FROM discovery_candidates WHERE url_key = ?", [key]);
    let id: number;
    let outcome: "created" | "updated";
    if (existing) {
      if (existing.state === "dismissed") return { outcome: "skipped", reason: "dismissed" };
      if (existing.state === "archived" || existing.state === "queued") return { outcome: "skipped", reason: "in_progress" };
      id = existing.id;
      outcome = "updated";
      const revive = existing.state === "expired";
      if (revive && this.poolFull(limits.maxCandidates)) return { outcome: "skipped", reason: "pool_full" };
      db.run(
        `UPDATE discovery_candidates SET last_seen_at = ?, depth = MIN(depth, ?), host = COALESCE(host, ?), state = CASE WHEN state = 'expired' THEN 'new' ELSE state END,
           expires_at = CASE WHEN origin_storage IN ('ttl','none') THEN expires_at ELSE ? END WHERE id = ?`,
        [now, input.depth, host, this.expiry(input), id]);
    } else {
      if (this.poolFull(limits.maxCandidates)) return { outcome: "skipped", reason: "pool_full" };
      const res = db.run(
        `INSERT INTO discovery_candidates (public_id, url, url_key, host, depth, state, score, est_bytes, suggested_source_id, origin_storage, first_seen_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'new', 0, ?, ?, ?, ?, ?, ?)`,
        [newId("cand"), u.href, key, host, input.depth, input.estBytes ?? null, input.suggestedSourceId ?? null, input.originStorage ?? null, now, now, this.expiry(input)]);
      id = Number(res.lastInsertRowid);
      outcome = "created";
    }
    this.addProvenance(id, input, now);
    this.o.changed?.(id);
    return { outcome, id };
  }

  keyOf(url: string): string { return this.o.urlKey(url); }
  isSensitive(u: URL): boolean { return isSensitiveUrl(u); }

  /** Adds one reason. The same reason on the same day is recorded once. Returns true when a row was added. */
  addProvenance(candidateId: number, p: Pick<AddInput, "kind" | "refPageId" | "refSourceId" | "refSearchId" | "detail" | "weight">, at: number): boolean {
    const origin = this.db.get<{ origin_storage: StorageKind | null }>("SELECT origin_storage FROM discovery_candidates WHERE id = ?", [candidateId])?.origin_storage;
    const detail = origin === "none" || origin === "ttl" ? null : (p.detail ?? null);
    return this.db.run(
      `INSERT INTO candidate_provenance (candidate_id, kind, ref_page_id, ref_search_id, ref_source_id, detail, weight, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [candidateId, p.kind, p.refPageId ?? null, p.refSearchId ?? null, p.refSourceId ?? null, detail, p.weight ?? null, at]).changes > 0;
  }

  private expiry(i: AddInput): number {
    return i.expiresAt ?? this.o.clock.now() + this.o.discovery().pool.expireAfterDays * 86_400_000;
  }

  private poolFull(max: number): boolean {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_candidates WHERE state IN ('new','approved')")!.n >= max;
  }

  /** True when a usable saved copy exists under this key or an alias of it. */
  isArchived(key: string): boolean {
    return !!this.db.get(
      `SELECT 1 AS x FROM pages p WHERE p.deleted_at IS NULL AND p.availability IN ('archived','partial')
         AND (p.url_key = ? OR p.id IN (SELECT page_id FROM page_aliases WHERE url_key = ?))`, [key, key]);
  }

  /** New and approved candidates past their expiry become `expired`; expired time-limited ones are deleted. Returns how many changed. */
  sweepExpired(): number {
    const now = this.o.clock.now();
    const gone = this.db.run("DELETE FROM discovery_candidates WHERE origin_storage = 'ttl' AND state IN ('new','approved','expired') AND expires_at <= ?", [now]).changes;
    const stale = this.db.run("UPDATE discovery_candidates SET state = 'expired' WHERE state IN ('new','approved') AND expires_at IS NOT NULL AND expires_at <= ? AND COALESCE(origin_storage, '') <> 'none'", [now]).changes;
    // Anything that became archived behind our back (the Human saved it, a crawl reached it) is closed.
    const done = this.db.run(
      `UPDATE discovery_candidates SET state = 'archived' WHERE state IN ('new','approved','expired') AND EXISTS (
         SELECT 1 FROM pages p WHERE p.deleted_at IS NULL AND p.availability IN ('archived','partial')
           AND (p.url_key = discovery_candidates.url_key OR p.id IN (SELECT page_id FROM page_aliases WHERE url_key = discovery_candidates.url_key)))`).changes;
    return gone + stale + done;
  }

  counts(): Record<CandidateState, number> {
    const out: Record<CandidateState, number> = { new: 0, approved: 0, queued: 0, archived: 0, dismissed: 0, expired: 0 };
    for (const r of this.db.all<{ state: CandidateState; n: number }>("SELECT state, COUNT(*) AS n FROM discovery_candidates GROUP BY state")) out[r.state] = r.n;
    return out;
  }
}
