import type { JobState } from "@ncb/shared";

/**
 * Allowed `jobs.state` transitions (docs/data-model.md section 3.5).
 *
 *   queued  -> running (claim) | held (pause) | cancelled
 *   running -> done | failed (no retry) | queued (retry after backoff, release, or lease expiry)
 *              | dead (attempts exhausted) | held | cancelled
 *   held    -> queued (resume) | cancelled
 *   failed  -> queued (manual retry)
 *   dead    -> queued (manual requeue from the dead-letter list)
 *   done, cancelled: terminal
 */
export const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "held", "cancelled"],
  running: ["done", "failed", "queued", "dead", "held", "cancelled"],
  held: ["queued", "cancelled"],
  failed: ["queued"],
  dead: ["queued"],
  done: [],
  cancelled: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: JobState): boolean {
  return TRANSITIONS[state].length === 0;
}

export class InvalidTransitionError extends Error {
  constructor(readonly from: JobState, readonly to: JobState) {
    super(`Job cannot move from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
