import { systemClock } from "@ncb/shared";

/** `none` is for a page a person saved by hand: one explicit request, never held up by a delay a crawl left on the host. */
export type PaceKind = "robots" | "page" | "asset" | "none";

export interface HostPacerOptions {
  /** The politeness delay of a host in milliseconds (`host_state.crawl_delay_ms`: the crawl's minimum delay, raised by robots.txt). 0 for a host nobody crawls. */
  delayOf(host: string): number;
  /**
   * Smallest gap between two sub-resource (asset) requests to one host when the host has a delay. Default 250 ms. A page can have a hundred
   * files on its own host, so spacing them by the full page delay would make a capture take minutes; this keeps the burst to four a second.
   */
  assetGapMs?: number;
  monotonic?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The per-host politeness gate for requests that happen inside one claimed job (HB-05). The queue spaces jobs by `host_state.next_allowed_at`,
 * but a job also fetches robots.txt and the page's files. Each of those asks here first: a request to a host waits until the host's last request
 * is `gap` milliseconds old (`gap` is the host delay for robots.txt and pages, `assetGapMs` or less for files). Waiters are queued in order, so
 * several parallel requests are spaced one by one. A host with no delay (a single page saved by hand) is never held up.
 */
export class HostPacer {
  private readonly last = new Map<string, number>();
  private readonly mono: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Requests that had to wait, for tests and the activity log. */
  waits = 0;

  constructor(private readonly o: HostPacerOptions) {
    this.mono = o.monotonic ?? systemClock.monotonic;
    this.sleep = o.sleep ?? realSleep;
  }

  gapFor(host: string, kind: PaceKind): number {
    const delay = Math.max(0, this.o.delayOf(host));
    if (delay === 0) return 0;
    return kind === "asset" ? Math.min(delay, this.o.assetGapMs ?? 250) : delay;
  }

  /** Reserves the next slot for `host` and waits for it. Resolves with the milliseconds waited. */
  async wait(host: string, kind: PaceKind, signal?: AbortSignal): Promise<number> {
    const gap = this.gapFor(host, kind);
    const now = this.mono();
    const prev = this.last.get(host);
    const slot = prev === undefined ? now : Math.max(now, prev + gap);
    // Reserve before sleeping so a second caller queues behind this one.
    this.last.set(host, slot);
    if (this.last.size > 5000) for (const [h, t] of this.last) if (t < now - 3_600_000) this.last.delete(h);
    const ms = slot - now;
    if (ms > 0) {
      this.waits++;
      await this.sleep(ms, signal);
    }
    return Math.max(0, ms);
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

interface HookedOptions { signal?: AbortSignal; hooks?: { beforeHop?: (info: { url: string }) => void | Promise<void> } }

/**
 * Wraps anything with a `fetch(url, opts)`: every call waits at the pacer first. `kindOf` chooses the class of request.
 * A `page` request is paced inside the fetcher's `beforeHop` hook, after the caller's own hook has run: that hook is where robots.txt is read,
 * so the wait falls between robots.txt and the page itself (and again at each redirect hop), which is the order the host sees.
 */
export function pacedFetcher<O extends HookedOptions, T extends { fetch(url: any, opts?: any): Promise<any> }>(
  inner: T, pacer: HostPacer, kindOf: (opts: O | undefined) => PaceKind,
): { fetch(url: string, opts?: O): Promise<any> } {
  return {
    async fetch(url, opts) {
      const kind = kindOf(opts);
      if (kind === "none") return inner.fetch(url, opts);
      if (kind === "page" && opts) {
        const orig = opts.hooks?.beforeHop;
        const wrapped = { ...opts, hooks: { ...opts.hooks, beforeHop: async (info: { url: string }) => {
          await orig?.(info);
          const h = hostOf(info.url);
          if (h) await pacer.wait(h, "page", opts.signal);
        } } } as O;
        return inner.fetch(url, wrapped);
      }
      const h = hostOf(url);
      if (h) await pacer.wait(h, kind, opts?.signal);
      return inner.fetch(url, opts);
    },
  };
}
