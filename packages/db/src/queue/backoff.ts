export interface BackoffOptions {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  /** Fraction of the delay added or removed at random, 0 to 1. Default 0.2. */
  jitter?: number;
}

export const DEFAULT_BACKOFF: Required<BackoffOptions> = { baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: 0.2 };

/** Delay before retry number `attempt` (1 = the first retry): base * factor^(attempt-1), capped, with jitter. */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}, random: () => number = Math.random): number {
  const o = { ...DEFAULT_BACKOFF, ...opts };
  const raw = Math.min(o.maxMs, o.baseMs * o.factor ** Math.max(0, attempt - 1));
  const jittered = raw * (1 + o.jitter * (2 * random() - 1));
  return Math.max(0, Math.min(o.maxMs, Math.round(jittered)));
}
