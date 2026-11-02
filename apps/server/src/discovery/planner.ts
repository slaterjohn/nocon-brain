/**
 * The runner's arithmetic (tasks D-04 and D-06), kept free of I/O so it can be tested exhaustively and with property tests.
 * Given what has been used today, what is in flight, and a list of eligible candidates (best first), it chooses the ones that may
 * start. Every limit is applied here, independently, and nothing that is chosen can push any counter past its limit: the chosen
 * downloads' byte allotments are also the caps handed to the capture, so the plan is a hard bound and not an estimate.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

/** Smallest allotment worth starting a download for. */
export const MIN_ALLOTMENT = 128 * KIB;
/** Largest allotment one download may be given. */
export const MAX_ALLOTMENT = 20 * MIB;
const DEFAULT_ESTIMATE = 1 * MIB;

export interface PlanCandidate {
  id: number;
  host: string;
  depth: number;
  estimatedBytes: number | null;
  /** The source whose storage budget the download counts against, if any. */
  sourceId: number | null;
}

export interface PlanInput {
  maxDepth: number;
  maxQueued: number;
  maxCandidatesPerRun: number;
  perSiteDailyCap: number;
  /** Discovery downloads queued or running now, from every lane. */
  inFlight: number;
  requests: { max: number; used: number };
  /** `used` counts what finished downloads took and what running ones may still take. */
  bytes: { max: number; used: number };
  /** Downloads started today per host (all lanes). */
  siteUsed: ReadonlyMap<string, number>;
  /** Free room on the best volume, after its reserve. */
  storageRoom: number;
  /** Remaining storage budget of a source that has one. */
  sourceRoom: ReadonlyMap<number, number>;
  candidates: readonly PlanCandidate[];
}

export type SkipReason = "depth" | "run_cap" | "queue_full" | "requests" | "bytes" | "site_cap" | "storage" | "source_budget";

export interface PlanOutput {
  start: { id: number; host: string; allotment: number; sourceId: number | null }[];
  skipped: { id: number; reason: SkipReason }[];
}

const nonNeg = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

export function allotmentFor(estimated: number | null, remainingBytes: number): number {
  const wanted = Math.min(MAX_ALLOTMENT, Math.max(MIN_ALLOTMENT * 4, 2 * (estimated ?? DEFAULT_ESTIMATE)));
  return Math.floor(Math.min(wanted, remainingBytes));
}

export function plan(i: PlanInput): PlanOutput {
  const out: PlanOutput = { start: [], skipped: [] };
  let bytesLeft = nonNeg(i.bytes.max - i.bytes.used);
  let requestsLeft = nonNeg(i.requests.max - i.requests.used);
  let queueLeft = nonNeg(i.maxQueued - i.inFlight);
  let runLeft = nonNeg(i.maxCandidatesPerRun);
  let storageLeft = nonNeg(i.storageRoom);
  const sites = new Map(i.siteUsed);
  const sourceLeft = new Map(i.sourceRoom);

  for (const c of i.candidates) {
    // Limits that end the pass for everyone behind this candidate too.
    if (runLeft <= 0) { out.skipped.push({ id: c.id, reason: "run_cap" }); continue; }
    if (queueLeft <= 0) { out.skipped.push({ id: c.id, reason: "queue_full" }); continue; }
    if (requestsLeft <= 0) { out.skipped.push({ id: c.id, reason: "requests" }); continue; }
    if (c.depth > i.maxDepth) { out.skipped.push({ id: c.id, reason: "depth" }); continue; }
    if ((sites.get(c.host) ?? 0) >= i.perSiteDailyCap) { out.skipped.push({ id: c.id, reason: "site_cap" }); continue; }
    if (bytesLeft < MIN_ALLOTMENT) { out.skipped.push({ id: c.id, reason: "bytes" }); continue; }
    let allot = allotmentFor(c.estimatedBytes, bytesLeft);
    if (c.sourceId !== null && sourceLeft.has(c.sourceId)) {
      const room = sourceLeft.get(c.sourceId)!;
      if (room < MIN_ALLOTMENT) { out.skipped.push({ id: c.id, reason: "source_budget" }); continue; }
      allot = Math.min(allot, room);
    }
    if (storageLeft < MIN_ALLOTMENT) { out.skipped.push({ id: c.id, reason: "storage" }); continue; }
    allot = Math.min(allot, storageLeft);
    if (allot < MIN_ALLOTMENT) { out.skipped.push({ id: c.id, reason: "bytes" }); continue; }

    out.start.push({ id: c.id, host: c.host, allotment: allot, sourceId: c.sourceId });
    bytesLeft -= allot;
    storageLeft -= allot;
    requestsLeft -= 1;
    queueLeft -= 1;
    runLeft -= 1;
    sites.set(c.host, (sites.get(c.host) ?? 0) + 1);
    if (c.sourceId !== null && sourceLeft.has(c.sourceId)) sourceLeft.set(c.sourceId, sourceLeft.get(c.sourceId)! - allot);
  }
  return out;
}
