export interface FrameState {
  versionId?: string;
  pageId?: string;
  url?: string;
  title?: string;
  state?: "ready" | "partial";
  /** Wall-clock ms of the last top-level document. */
  at: number;
}

/**
 * The last top-level document the listener served per frame id (D-5). The API's `frame-state` endpoint reads it; the
 * listener only writes. Bounded, least recently updated first out.
 */
export class FrameStateStore {
  private readonly map = new Map<string, FrameState>();
  constructor(private readonly max = 2000) {}

  record(frameId: string, state: FrameState): void {
    this.map.delete(frameId);
    this.map.set(frameId, state);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  get(frameId: string): FrameState | undefined {
    return this.map.get(frameId);
  }
}

/** Collects version ids served and flushes them in one call (task A-13 `last_accessed_at` batching). */
export class AccessBatcher {
  private pending = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly flushFn: (ids: string[], atMs: number) => Promise<void> | void,
    private readonly now: () => number,
    private readonly intervalMs = 30_000,
    private readonly maxPending = 200,
  ) {}

  touch(versionId: string): void {
    this.pending.add(versionId);
    if (this.pending.size >= this.maxPending) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.intervalMs);
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const ids = [...this.pending];
    this.pending = new Set();
    try {
      await this.flushFn(ids, this.now());
    } catch {
      /* best effort: access times are advisory */
    }
  }
}
