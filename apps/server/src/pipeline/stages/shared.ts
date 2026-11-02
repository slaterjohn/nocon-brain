import { decodeHtml } from "@ncb/content";
import type { StageContext } from "../types.js";
import { StageFailure } from "../types.js";
import { loadVersion, type VersionRow } from "../store.js";

export const version = (ctx: StageContext): VersionRow => {
  const v = loadVersion(ctx.deps.db, ctx.versionId);
  if (!v) throw new StageFailure("The version no longer exists.", "internal");
  return v;
};

/** The decoded original HTML. Cached for the run so later stages do not decode it again. */
export async function documentHtml(ctx: StageContext, v: VersionRow = version(ctx)): Promise<string> {
  const hit = ctx.cache.get("html");
  if (typeof hit === "string") return hit;
  if (!v.rawHash) throw new StageFailure("The version has no stored original.", "internal");
  const { data } = await ctx.deps.blobs.read(v.rawHash).catch(() => {
    throw new StageFailure("The stored original is missing from disk.", "internal");
  });
  const { text } = decodeHtml(data, v.headers["content-type"]);
  ctx.cache.set("html", text);
  return text;
}

export function setDetail(ctx: StageContext, stage: string, detail: Record<string, unknown>): void {
  ctx.deps.db.run("UPDATE pipeline_stage_runs SET detail_json = ? WHERE version_id = ? AND stage = ?", [JSON.stringify(detail), ctx.versionId, stage]);
}

export function stageDetail(ctx: StageContext, stage: string): Record<string, unknown> {
  const r = ctx.deps.db.get<{ detail_json: string | null }>("SELECT detail_json FROM pipeline_stage_runs WHERE version_id = ? AND stage = ?", [ctx.versionId, stage]);
  return r?.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : {};
}

export function blobKindFor(mime: string | null, role: string): "css" | "image" | "font" | "media" | "pdf" | "other" {
  const m = (mime ?? "").toLowerCase();
  if (m === "text/css" || (role === "stylesheet" && !m.startsWith("image/"))) return "css";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("font/") || /(?:woff|ttf|otf|opentype|font)/.test(m) || role === "font") return "font";
  if (m.startsWith("audio/") || m.startsWith("video/")) return "media";
  if (m === "application/pdf") return "pdf";
  return "other";
}

/** The import kind of a version made from an uploaded file, or null for a captured web page (task C-14). */
export function importKindOf(ctx: StageContext, versionId: number = ctx.versionId): "html" | "pdf" | "text" | "markdown" | null {
  return ctx.deps.db.get<{ kind: "html" | "pdf" | "text" | "markdown" }>("SELECT kind FROM import_documents WHERE version_id = ?", [versionId])?.kind ?? null;
}
