import type { ExtractedLink } from "@ncb/content";
import { registrableDomain } from "@ncb/content";
import type { StageContext, StageFn } from "../types.js";
import { ExtractionRefused } from "../extract-client.js";
import { deleteVersion } from "../store.js";
import { documentHtml, version } from "./shared.js";

/** Stage 7: outbound links with region, density, anchor, position and URL-shape features, plus a score (task A-09). */
export const links: StageFn = async (ctx) => {
  const { db, extract, urlKey } = ctx.deps;
  const v = version(ctx);
  const html = await documentHtml(ctx, v);
  let found: ExtractedLink[] = [];
  let rejected: string | undefined;
  try {
    found = await extract.run<ExtractedLink[]>({ op: "links", html, url: v.finalUrl });
  } catch (e) {
    if (!(e instanceof ExtractionRefused)) throw e;
    rejected = e.reason;
  }
  db.transaction(() => {
    db.run("DELETE FROM links WHERE from_version_id = ?", [v.id]);
    for (const l of found) {
      let key: string;
      try {
        key = urlKey(l.url);
      } catch {
        continue;
      }
      db.run(
        `INSERT INTO links (from_version_id, from_page_id, to_url, to_url_key, anchor_text, context, region, score, features_json, is_internal, rel_nofollow, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.id, v.pageId, l.url, key, l.anchorText, l.context, l.region, l.score, JSON.stringify(l.features), l.isInternal ? 1 : 0, l.relNofollow ? 1 : 0, l.position],
      );
    }
  });
  const byRegion: Record<string, number> = {};
  for (const l of found) byRegion[l.region] = (byRegion[l.region] ?? 0) + 1;
  return { detail: { links: found.length, byRegion, ...(rejected ? { rejected } : {}) } };
};

interface PageRef {
  id: number;
  url_key: string;
  version_count: number;
  latest_version_id: number | null;
}

export function pageByKey(ctx: Pick<StageContext, "deps">, key: string): PageRef | undefined {
  const { db } = ctx.deps;
  return (
    db.get<PageRef>("SELECT id, url_key, version_count, latest_version_id FROM pages WHERE url_key = ?", [key]) ??
    db.get<PageRef>(
      `SELECT p.id, p.url_key, p.version_count, p.latest_version_id FROM page_aliases a JOIN pages p ON p.id = a.page_id WHERE a.url_key = ?`, [key])
  );
}

const stripSlash = (k: string) => (k.endsWith("/") && !/^[a-z]+:\/\/[^/]+\/$/.test(k) ? k.slice(0, -1) : k);

/**
 * Stage 8: canonical URL, redirects and aliases. A canonical link is accepted only when it stays on the same
 * registrable domain. The version is filed under the canonical page; redirect and canonical differences become
 * `page_aliases` rows rather than duplicate pages (task A-09).
 */
export const normalise: StageFn = (ctx) => {
  const { db, clock, urlKey, newId } = ctx.deps;
  const v = version(ctx);
  const meta = v.metadata as { canonicalUrl?: string | null } | null;
  const finalUrl = new URL(v.finalUrl);
  let target = finalUrl.href;
  let canonicalAccepted = false;
  let canonicalRejected: string | undefined;
  if (meta?.canonicalUrl) {
    try {
      const c = new URL(meta.canonicalUrl);
      if ((c.protocol === "http:" || c.protocol === "https:") && registrableDomain(c.hostname) === registrableDomain(finalUrl.hostname)) {
        target = c.href.split("#")[0]!;
        canonicalAccepted = true;
      } else canonicalRejected = "different registrable domain";
    } catch {
      canonicalRejected = "not a URL";
    }
  }
  const now = clock.now();
  const targetKey = urlKey(target);
  const finalKey = urlKey(v.finalUrl);
  const reqKey = urlKey(v.requestedUrl);

  const result = db.transaction(() => {
    const current = db.get<{ id: number; url_key: string; version_count: number; latest_version_id: number | null }>(
      "SELECT id, url_key, version_count, latest_version_id FROM pages WHERE id = ?", [v.pageId])!;
    const oldKeys = new Set<string>([current.url_key, reqKey, finalKey]);
    const existing = pageByKey(ctx, targetKey);
    let pageId = current.id;
    let moved = false;
    if (existing && existing.id !== current.id) {
      // File the version under the page that already owns the canonical URL.
      const next = (db.get<{ n: number }>("SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM page_versions WHERE page_id = ?", [existing.id])!).n;
      db.run("UPDATE page_versions SET page_id = ?, version_no = ? WHERE id = ?", [existing.id, next, v.id]);
      db.run("UPDATE links SET from_page_id = ? WHERE from_version_id = ?", [existing.id, v.id]);
      pageId = existing.id;
      moved = true;
    } else if (!existing && current.url_key !== targetKey) {
      const others = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ? AND id <> ?", [current.id, v.id])!.n;
      if (others === 0 && current.version_count === 0) {
        // A provisional page created for this capture: re-key it in place.
        const u = new URL(target);
        db.run("UPDATE pages SET url_key = ?, canonical_url = ?, host = ?, registrable_domain = ? WHERE id = ?", [targetKey, target, u.hostname.toLowerCase(), registrableDomain(u.hostname), current.id]);
      } else {
        const u = new URL(target);
        const created = db.run(
          `INSERT INTO pages (public_id, url_key, canonical_url, host, registrable_domain, origin, content_type, availability, created_at) VALUES (?, ?, ?, ?, ?, 'web', 'html', 'failed', ?)`,
          [newId("pg"), targetKey, target, u.hostname.toLowerCase(), registrableDomain(u.hostname), now],
        );
        pageId = Number(created.lastInsertRowid);
        db.run("UPDATE page_versions SET page_id = ?, version_no = 1 WHERE id = ?", [pageId, v.id]);
        db.run("UPDATE links SET from_page_id = ? WHERE from_version_id = ?", [pageId, v.id]);
        moved = true;
      }
    }
    // A provisional page left empty by the move is removed; its aliases were re-pointed above where they mattered.
    if (moved && current.id !== pageId) {
      const left = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?", [current.id])!.n;
      if (left === 0 && current.version_count === 0 && current.latest_version_id === null) {
        db.run("UPDATE page_aliases SET page_id = ? WHERE page_id = ?", [pageId, current.id]);
        db.run("DELETE FROM pages WHERE id = ?", [current.id]);
      }
    }
    // Aliases: every key we reached this page by, except the page's own key.
    const page = db.get<{ id: number; url_key: string }>("SELECT id, url_key FROM pages WHERE id = ?", [pageId])!;
    const aliases: string[] = [];
    for (const k of oldKeys) {
      if (k === page.url_key) continue;
      const owner = db.get<{ id: number }>("SELECT id FROM pages WHERE url_key = ?", [k]);
      if (owner) continue; // that key is a page of its own; aliases never shadow pages
      const kind = stripSlash(k) === stripSlash(page.url_key) ? "trailing_slash" : k === reqKey && reqKey !== finalKey ? "redirect" : canonicalAccepted ? "canonical" : "alias";
      const r = db.run("INSERT INTO page_aliases (url_key, page_id, kind, first_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(url_key) DO UPDATE SET page_id = excluded.page_id WHERE page_id <> excluded.page_id", [k, pageId, kind, now]);
      if (r.changes) aliases.push(`${kind}:${k}`);
    }
    return { pageId, moved, aliases };
  });
  return { detail: { canonical: canonicalAccepted ? target : null, ...(canonicalRejected ? { canonicalRejected } : {}), pageId: result.pageId, moved: result.moved, aliases: result.aliases } };
};

/**
 * Stage 9: dedup (task A-10). An exact repeat of the page's latest content under the `on_change` policy ends the
 * capture as unchanged. The same text under a different page is flagged on the version. The `simhash` column is
 * left unused (near-duplicate detection is post-v1).
 */
export const dedup: StageFn = (ctx) => {
  const { db } = ctx.deps;
  const v = version(ctx);
  const page = db.get<{ latest_version_id: number | null }>("SELECT latest_version_id FROM pages WHERE id = ?", [v.pageId])!;
  const hash = v.contentHash;
  if (ctx.versioning.mode === "on_change" && page.latest_version_id && hash) {
    const latest = db.get<{ id: number; content_hash: string | null }>("SELECT id, content_hash FROM page_versions WHERE id = ? AND status IN ('ready','partial')", [page.latest_version_id]);
    if (latest && latest.content_hash === hash && latest.id !== v.id) return { outcome: "unchanged", detail: { reason: "content_hash", sameAs: latest.id } };
  }
  let duplicateOf: number | null = null;
  if (hash) {
    const dup = db.get<{ id: number }>(
      `SELECT id FROM page_versions WHERE content_hash = ? AND page_id <> ? AND status IN ('ready','partial') ORDER BY id LIMIT 1`, [hash, v.pageId]);
    duplicateOf = dup?.id ?? null;
  }
  db.run("UPDATE page_versions SET duplicate_of_version_id = ? WHERE id = ?", [duplicateOf, v.id]);
  return { detail: { duplicateOfVersionId: duplicateOf } };
};

/** Used when a capture ends as unchanged: record the check, refresh validators, then drop the new version. */
export function discardAsUnchanged(ctx: StageContext, versionId: number, reason: string): void {
  const { db, blobs, clock } = ctx.deps;
  const v = db.get<{ page_id: number; etag: string | null; last_modified: string | null; headers_json: string | null }>(
    "SELECT page_id, etag, last_modified, headers_json FROM page_versions WHERE id = ?", [versionId]);
  if (!v) return;
  db.transaction(() => {
    const page = db.get<{ latest_version_id: number | null; version_count: number }>("SELECT latest_version_id, version_count FROM pages WHERE id = ?", [v.page_id])!;
    db.run("UPDATE pages SET last_checked_at = ? WHERE id = ?", [clock.now(), v.page_id]);
    if (page.latest_version_id && (v.etag || v.last_modified)) {
      db.run("UPDATE page_versions SET etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified) WHERE id = ?", [v.etag, v.last_modified, page.latest_version_id]);
    }
    deleteVersion(db, blobs, versionId);
    if (page.version_count === 0 && page.latest_version_id === null) {
      const left = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?", [v.page_id])!.n;
      if (left === 0) db.run("DELETE FROM pages WHERE id = ?", [v.page_id]);
    }
  });
  ctx.deps.activity.write({ level: "info", area: "pipeline", message: `Unchanged since the last capture (${reason}); no new version`, versionId: undefined });
}
