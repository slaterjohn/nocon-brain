export interface FrameState {
  versionId?: string;
  pageId?: string;
  url?: string;
  title?: string;
  /** `ready` and `partial` for archived documents; the interstitial records the link state of the address it shows. */
  state?: "ready" | "partial" | "live-only" | "queued" | "unavailable" | "unsupported" | "zim";
  /** A knowledge-package entry (state `zim`): the package's `zim_` id and the entry path. */
  zimId?: string;
  zimPath?: string;
  /** The document was the reader view. */
  reader?: boolean;
  /** The listener served its interstitial (an address that is not in the archive) rather than an archived page. */
  interstitial?: boolean;
  /** Wall-clock ms of the last top-level document. */
  at: number;
  /** Counts documents served per listener process; two documents in the same millisecond still differ. */
  seq?: number;
  /** The signed-in user the frame's capability was minted for (0 or absent for a guest). */
  userId?: number;
}

/**
 * The last top-level document the listener served per frame id (D-5). The API's `frame-state` endpoint reads it; the
 * listener only writes. Bounded, least recently updated first out.
 */
export class FrameStateStore {
  private readonly map = new Map<string, FrameState>();
  constructor(private readonly max = 2000) {}

  private seq = 0;

  private readonly listeners = new Set<(frameId: string, state: FrameState) => void>();

  /** Called after each document is recorded, in the listener's own request, so a visit is known without waiting for a client to ask. */
  onRecord(fn: (frameId: string, state: FrameState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  record(frameId: string, state: FrameState): void {
    this.map.delete(frameId);
    const stored = { ...state, seq: ++this.seq };
    this.map.set(frameId, stored);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    for (const fn of this.listeners) {
      try { fn(frameId, stored); } catch { /* a subscriber's failure never breaks serving */ }
    }
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
