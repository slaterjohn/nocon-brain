import type { Priority } from "./types";
import { formatBytes } from "./utils";

/** Types and plain helpers for the Storage screens (docs/api.md section 10). No React in here, so it is unit tested. */

export type Iso = string;

/**
 * The page explanation sends the priority of a copy and of a reference as a number (1 to 4) where the rest of the storage API
 * sends "P1" to "P4" (see docs/api.md 10.5). Both are accepted and read as "P1" to "P4".
 */
export type AnyPriority = Priority | 1 | 2 | 3 | 4;
export function asPriority(p: AnyPriority | number | string | null | undefined): Priority | null {
  if (p === null || p === undefined) return null;
  if (typeof p === "number") return p >= 1 && p <= 4 ? (`P${p}` as Priority) : null;
  return /^P[1-4]$/.test(p) ? (p as Priority) : /^[1-4]$/.test(p) ? (`P${p}` as Priority) : null;
}
export type VolumeState = "online" | "offline" | "readonly" | "draining" | "disabled";

export interface Volume {
  id: string;
  name: string;
  rootPath: string;
  state: VolumeState;
  isDefault: boolean;
  capacityBytes: number;
  quotaBytes?: number | null;
  usedBytes: number;
  availableBytes: number;
  reservedBytes: number;
  reserveFreeBytes: number;
  thresholds: { softPct: number; evictStartPct: number; evictTargetPct: number };
  usageByPriority: Record<Priority, number>;
}
export interface VolumeDetail extends Volume {
  reservations: { downloadJobId: string; reservedBytes: number; writtenBytes: number; expiresAt: Iso }[];
  blobCount: number;
}

export interface UsageRow { key: string; label?: string; exclusiveBytes: number; sharedBytes: number; blobCount: number }
export interface UsageReport { by: "priority" | "source" | "kind" | "volume"; totalBytes: number; blobCount: number; unreferencedBytes: number; items: UsageRow[]; computedAt: Iso }

export interface StorageForecast {
  estimate: true;
  horizonDays: number;
  projectedUsedBytes: { low: number; high: number };
  growthBytesPerDay: { low: number; high: number };
  projectedFullAt?: { earliest: Iso; latest?: Iso };
  perSource: { sourceId: string; name: string; observedPages: number; bytesPerPage: { low: number; high: number }; plannedPages: number; plannedBytes: { low: number; high: number } }[];
  confidence: "low" | "medium";
  assumptions: string[];
}

export interface StoragePolicy {
  permitImportantEviction: boolean;
  permitAcknowledgedAt: Iso | null;
  throttleOpportunistic: boolean;
  pruneSurplusVersions: boolean;
  orphanGraceSeconds: number;
  autoEviction: boolean;
  maxEvictionBatchBytes: number | null;
  forecastHorizonDays: number;
  scrubMegabytesPerRun: number;
  protectedNeverEvicted: true;
  warnings: { permitImportantEviction: string };
  volumeThresholds: { volumeId: string; name: string; softPct: number; evictStartPct: number; evictTargetPct: number }[];
}

export type EvictionTrigger = "admission" | "threshold" | "prune" | "manual" | "recovery";
export type RunState = "running" | "done" | "failed" | "interrupted";

export interface StorageOverview {
  volumes: Volume[];
  totals: { capacityBytes: number; usedBytes: number; availableBytes: number; reservedBytes: number; unreferencedBytes: number };
  usageByPriority: UsageRow[];
  usageBySource: UsageRow[];
  forecast: StorageForecast;
  policy: StoragePolicy;
  eviction: {
    autoEviction: boolean;
    throttling: boolean;
    overThreshold: string[];
    lastRun?: { id: string; trigger: EvictionTrigger; state: RunState; versionsEvicted: number; bytesFreed: number; startedAt: Iso };
  };
  maintenance: { lastRun?: { id: string; kind: "verify" | "repair"; dryRun: boolean; startedAt: Iso } };
  computedAt: Iso;
}

export type SkipReason = "p1" | "source_auto_eviction_off" | "p2_not_permitted" | "priority_gate" | "in_use" | "retained" | "no_reclaim" | "not_on_volume";
export type PlanStep = "throttle_p4" | "unreferenced_blobs" | "surplus_versions" | "p4" | "p3" | "p2";

export interface EvictionPlan {
  planId: string;
  createdAt: Iso;
  expiresAt: Iso;
  mode: "pressure" | "prune";
  incomingPriority: Priority;
  bytesNeeded: number;
  volumeId?: string;
  reclaimableBytes: number;
  sufficient: boolean;
  insufficient: boolean;
  throttleOpportunistic: boolean;
  steps: { step: PlanStep; versions: number; exclusiveBytes: number }[];
  itemsTotal: number;
  items: { versionId: string; pageId: string; pageUrl: string; versionNo: number; priority: Priority; surplus: boolean; step: PlanStep; reason: string; exclusiveBytes: number; lastAccessedAt?: Iso }[];
  unreferencedBlobs: { count: number; bytes: number };
  skipped: { versionId: string; pageId: string; pageUrl: string; reason: SkipReason }[];
  skippedCounts: Partial<Record<SkipReason, number>>;
  summary: string;
}

export interface EvictionRunRow {
  id: string; trigger: EvictionTrigger; state: RunState; incomingPriority: Priority; bytesNeeded: number;
  versionsPlanned: number; versionsEvicted: number; versionsSkipped: number; bytesFreed: number; blobsDeleted: number;
  error?: string; startedAt: Iso; finishedAt?: Iso;
}
export interface EvictionResult { runId: string; planned: number; evicted: number; bytesFreed: number; blobsDeleted: number; evictedVersionIds: string[]; skipped: { versionId: string; reason: SkipReason | "changed" }[] }

export interface ReferenceSummary { kind: "source" | "collection" | "pin" | "bookmark"; id: string; label?: string; priority: AnyPriority; autoEvict: boolean; retains: boolean }
export interface AuditRecord {
  id: number; kind: "evicted" | "deleted"; at: Iso; pageId: string | null; pageUrl: string; versionId: string | null; versionNo: number | null;
  priority: Priority | null; surplus: boolean; step: string | null; reason: string; trigger: EvictionTrigger | "explicit" | null;
  exclusiveBytes: number; references: ReferenceSummary[]; confirmedProtected: boolean; runId?: string;
}
export interface VersionExplanation {
  versionId: string; status: string; isLatest: boolean; priority: AnyPriority; surplus: boolean; decision: "kept" | "evictable"; skipReason?: SkipReason;
  references: ReferenceSummary[]; reasons: string[];
}
export interface PageStorageExplanation {
  page: { id: string; url: string; availability: string; effectivePriority: Priority; cachedPriority: Priority | null };
  pin: { priority: Priority; reason: string | null } | null;
  references: ReferenceSummary[];
  versions: (VersionExplanation & { versionNo: number; fetchedAt: Iso; evictedAt?: Iso; audit?: AuditRecord })[];
  history: AuditRecord[];
}

export interface MaintenanceFinding { invariant: string; title: string; count: number; examples: string[]; repaired?: number; note?: string }
export interface MaintenanceRun {
  id: string; kind: "verify" | "repair" | "integrity_check" | "scrub"; dryRun: boolean; state: "running" | "done" | "failed";
  startedAt: Iso; finishedAt?: Iso; findings: MaintenanceFinding[]; checked: Record<string, number>; skipped: { invariant: string; reason: string }[];
}
export type MaintenanceListItem = Pick<MaintenanceRun, "id" | "kind" | "dryRun" | "state" | "startedAt" | "finishedAt">;

// ---- copy -------------------------------------------------------------------------------------

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  p1: "Protected (P1). Protected content is never removed automatically.",
  source_auto_eviction_off: "A source or pin that uses this page does not allow automatic removal.",
  p2_not_permitted: "Important (P2) content, and removing it has not been allowed in the policy.",
  priority_gate: "A download of this priority may only free content that is less important than itself.",
  in_use: "A download is writing to this page, or the copy is not complete.",
  retained: "Something still keeps this copy, so tidying leaves it alone.",
  no_reclaim: "All of its files are shared with content that stays, so removing it would free nothing.",
  not_on_volume: "None of its files are on the volume being freed.",
};

export const STEP_TEXT: Record<PlanStep, string> = {
  throttle_p4: "Slow Opportunistic downloads (nothing is deleted for this)",
  unreferenced_blobs: "Unused files past the grace period",
  surplus_versions: "Surplus copies that nothing keeps any more",
  p4: "Opportunistic (P4) content",
  p3: "Standard (P3) content",
  p2: "Important (P2) content",
};

export const TRIGGER_TEXT: Record<EvictionTrigger | "explicit", string> = {
  admission: "A download needed room",
  threshold: "A volume passed its eviction threshold",
  prune: "Tidy-up of surplus copies",
  manual: "Run by hand",
  recovery: "Finished after an interruption",
  explicit: "Deleted by hand",
};

export const RUN_STATE_TEXT: Record<RunState, string> = { running: "Running", done: "Finished", failed: "Failed", interrupted: "Interrupted" };

export const VOLUME_STATE_TEXT: Record<VolumeState, string> = {
  online: "Online",
  offline: "Offline",
  readonly: "Read only",
  draining: "Draining",
  disabled: "Disabled",
};

export const VOLUME_STATE_HELP: Record<VolumeState, string> = {
  online: "Working. New files can be written here.",
  offline: "The drive's marker file is missing or does not match. Its records are kept and its files cannot be read, so saved copies on it show as unavailable. Nothing on it is removed. It comes back by itself when the drive is reconnected.",
  readonly: "Files can be read but nothing new is written here.",
  draining: "No new files are written here. Wait for it to empty before removing it.",
  disabled: "Switched off. Its files are not used.",
};

export const KIND_TEXT: Record<string, string> = {
  document: "Page documents",
  html: "Page documents",
  asset: "Images and other files",
  image: "Images",
  style: "Style sheets",
  stylesheet: "Style sheets",
  script: "Scripts",
  font: "Fonts",
  media: "Audio and video",
  text: "Reader text",
  pdf: "PDFs",
  original: "Original uploads",
  other: "Other files",
};

export function kindLabel(key: string): string {
  return KIND_TEXT[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}

export const PRIORITY_NAME: Record<Priority, string> = { P1: "P1 Protected", P2: "P2 Important", P3: "P3 Standard", P4: "P4 Opportunistic" };

/** Row label for a usage row: priorities get their names, `unreferenced` says how it is counted. */
export function usageLabel(by: UsageReport["by"], row: UsageRow): string {
  if (by === "priority") {
    if (row.key === "unreferenced") return "Unused files (counted as Opportunistic)";
    return PRIORITY_NAME[row.key as Priority] ?? row.key;
  }
  if (by === "kind") return kindLabel(row.key);
  if (row.key === "unassigned") return "Not in any source";
  return row.label ?? row.key;
}

// ---- numbers ----------------------------------------------------------------------------------

/** The room NoConBrain has on a volume: its quota, else its own bytes plus the free space. Thresholds are shares of this. */
export function volumeRoomBytes(v: Pick<Volume, "quotaBytes" | "usedBytes" | "availableBytes">): number {
  return v.quotaBytes != null ? v.quotaBytes : v.usedBytes + v.availableBytes;
}

/** Disk usage as a whole percent, 0 to 100. Disk usage is the one thing the Storage screens show as a percentage. */
export function volumeUsedPct(v: Pick<Volume, "quotaBytes" | "usedBytes" | "availableBytes" | "reservedBytes">): number {
  const room = volumeRoomBytes(v);
  if (room <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((v.usedBytes + v.reservedBytes) / room) * 100)));
}

export function rangeText(low: number, high: number, fmt: (n: number) => string = (n) => formatBytes(n)): string {
  const a = fmt(low);
  const b = fmt(high);
  return a === b ? `about ${a}` : `${a} to ${b}`;
}

export function splitTotals(rows: UsageRow[]): { exclusive: number; shared: number; files: number } {
  return rows.reduce((t, r) => ({ exclusive: t.exclusive + r.exclusiveBytes, shared: t.shared + r.sharedBytes, files: t.files + r.blobCount }), { exclusive: 0, shared: 0, files: 0 });
}

/** The widest bar a row needs, so bars in one table share a scale. Returns 0 when everything is empty. */
export function barScale(rows: UsageRow[]): number {
  return rows.reduce((m, r) => Math.max(m, r.exclusiveBytes + r.sharedBytes), 0);
}

/** Bar segment widths as CSS lengths relative to the widest row. They are decorative: the numbers sit beside them as text. */
export function barWidths(row: UsageRow, scale: number): { exclusive: string; shared: string } {
  if (scale <= 0) return { exclusive: "0%", shared: "0%" };
  const w = (n: number) => `${Math.max(n > 0 ? 1 : 0, Math.round((n / scale) * 1000) / 10)}%`;
  return { exclusive: w(row.exclusiveBytes), shared: w(row.sharedBytes) };
}

/** One plain sentence per forecast figure. Never a single number. */
export function growthText(f: Pick<StorageForecast, "growthBytesPerDay">): string {
  const { low, high } = f.growthBytesPerDay;
  if (high <= 0) return "No growth expected from recent history.";
  return `Between ${formatBytes(low)} and ${formatBytes(high)} a day`;
}

export function projectedUsedText(f: Pick<StorageForecast, "projectedUsedBytes" | "horizonDays">): string {
  return `Between ${formatBytes(f.projectedUsedBytes.low)} and ${formatBytes(f.projectedUsedBytes.high)} in ${f.horizonDays} days`;
}

export function fullAtText(f: Pick<StorageForecast, "projectedFullAt">, fmtDate: (iso: string) => string = (s) => s.slice(0, 10)): string {
  const full = f.projectedFullAt;
  if (!full) return "Not expected to fill within ten years at this rate.";
  if (!full.latest) return `Could fill from ${fmtDate(full.earliest)} if growth is at the high end. At the low end it does not grow.`;
  return `Could fill between ${fmtDate(full.earliest)} and ${fmtDate(full.latest)}.`;
}

export function confidenceText(c: StorageForecast["confidence"]): string {
  return c === "low" ? "Low confidence: there are fewer than three whole days of history." : "Medium confidence.";
}

// ---- volume form ------------------------------------------------------------------------------

export interface ThresholdInput { softPct: number; evictStartPct: number; evictTargetPct: number }

/** Mirrors the server rule: 1 to 100, soft <= evict start, target < evict start. Returns field errors keyed by field name. */
export function thresholdErrors(t: ThresholdInput): Record<string, string> {
  const e: Record<string, string> = {};
  const whole = (n: number) => Number.isInteger(n) && n >= 1 && n <= 100;
  if (!whole(t.softPct)) e.softPct = "Enter a whole number from 1 to 100.";
  if (!whole(t.evictStartPct)) e.evictStartPct = "Enter a whole number from 1 to 100.";
  if (!whole(t.evictTargetPct)) e.evictTargetPct = "Enter a whole number from 1 to 100.";
  if (!e.softPct && !e.evictStartPct && t.softPct > t.evictStartPct) e.softPct = "The soft threshold can't be above the eviction start.";
  if (!e.evictTargetPct && !e.evictStartPct && t.evictTargetPct >= t.evictStartPct) e.evictTargetPct = "The eviction target must be below the eviction start.";
  return e;
}

export type SizeUnit = "MB" | "GB" | "TB";
const UNIT_BYTES: Record<SizeUnit, number> = { MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** Turns "50" and "GB" into bytes. Empty means none (null). NaN, zero and negatives are an error (undefined). */
export function toBytes(text: string, unit: SizeUnit): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * UNIT_BYTES[unit]);
}

/** The inverse, picking the largest unit that keeps the number at 1 or more. */
export function fromBytes(bytes: number | null | undefined): { text: string; unit: SizeUnit } {
  if (!bytes) return { text: "", unit: "GB" };
  const unit: SizeUnit = bytes >= UNIT_BYTES.TB ? "TB" : bytes >= UNIT_BYTES.GB ? "GB" : "MB";
  const v = bytes / UNIT_BYTES[unit];
  return { text: String(Math.round(v * 100) / 100), unit };
}

// ---- eviction plans ---------------------------------------------------------------------------

/** What to tell the Human about a plan, in the order they need it. */
export function planHeadline(p: Pick<EvictionPlan, "sufficient" | "reclaimableBytes" | "bytesNeeded" | "itemsTotal" | "unreferencedBlobs">): string {
  const freed = formatBytes(p.reclaimableBytes);
  const things = p.itemsTotal + p.unreferencedBlobs.count;
  if (things === 0) return "Nothing can be removed automatically, so this plan would free nothing.";
  if (!p.sufficient) {
    return p.bytesNeeded > 0
      ? `Not enough. Everything that may be removed would free ${freed}, but ${formatBytes(p.bytesNeeded)} is needed. This plan cannot be run.`
      : `Not enough. This plan would free ${freed}, which does not bring the volume down to its target. This plan cannot be run.`;
  }
  return `Would free ${freed} from ${p.itemsTotal.toLocaleString("en-GB")} ${p.itemsTotal === 1 ? "saved copy" : "saved copies"}${p.unreferencedBlobs.count ? ` and ${p.unreferencedBlobs.count.toLocaleString("en-GB")} unused ${p.unreferencedBlobs.count === 1 ? "file" : "files"}` : ""}.`;
}

export function skippedSummary(counts: Partial<Record<SkipReason, number>>): { reason: SkipReason; count: number }[] {
  return (Object.entries(counts) as [SkipReason, number][]).filter(([, n]) => n > 0).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

export function maintenanceHeadline(r: Pick<MaintenanceRun, "dryRun" | "findings" | "state">): string {
  if (r.state === "failed") return "The check failed to finish.";
  const total = r.findings.reduce((n, f) => n + f.count, 0);
  if (total === 0) return r.dryRun ? "Nothing was wrong. This was a dry run, so nothing was changed either way." : "Nothing was wrong, so nothing needed repair.";
  const kinds = r.findings.length;
  const base = `${total.toLocaleString("en-GB")} ${total === 1 ? "problem" : "problems"} found in ${kinds} ${kinds === 1 ? "check" : "checks"}.`;
  if (r.dryRun) return `${base} This was a dry run: nothing was changed.`;
  const fixed = r.findings.reduce((n, f) => n + (f.repaired ?? 0), 0);
  return `${base} ${fixed.toLocaleString("en-GB")} repaired.`;
}

/** Which downloads page text to show for a `wait` reason. Falls back to the server's message. */
export function waitText(wait: { reason: string; message: string } | undefined): string | null {
  if (!wait) return null;
  if (wait.reason === "throttled") return "Waiting: background Opportunistic (P4) downloads are paused while storage is above its soft threshold. This one continues when space is freed.";
  return wait.message;
}
