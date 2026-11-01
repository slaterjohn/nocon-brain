import type { Clock } from "@ncb/shared";
import { AppError } from "@ncb/shared";
import type { EventBus } from "./events.js";
import type { SettingsService } from "./settings.js";

export type ConnState = "unknown" | "online" | "offline";
export type ConnSource = "passive" | "probe" | "forced";

/** Consecutive network-level failures before passive observation says offline. */
export const PASSIVE_OFFLINE_AFTER = 3;

export type ConnEvent =
  | { type: "success" }
  | { type: "network_failure" }
  | { type: "probe"; ok: boolean };

export interface Observed {
  state: ConnState;
  source: ConnSource;
  failures: number;
}

/**
 * The state machine for what the server has observed (docs/architecture.md section 9, D-8). Any outbound
 * request that reached a server proves we are online. `PASSIVE_OFFLINE_AFTER` network failures in a row
 * (DNS, connect, timeout) say offline. A probe is authoritative in both directions. The forced-offline switch
 * is applied on top of this, not inside it, so switching it off restores what was observed.
 */
export function reduceConnectivity(cur: Observed, e: ConnEvent): Observed {
  switch (e.type) {
    case "success":
      return { state: "online", source: cur.source === "probe" ? "probe" : "passive", failures: 0 };
    case "network_failure": {
      const failures = cur.failures + 1;
      return failures >= PASSIVE_OFFLINE_AFTER
        ? { state: "offline", source: "passive", failures }
        : { ...cur, failures };
    }
    case "probe":
      return e.ok
        ? { state: "online", source: "probe", failures: 0 }
        : { state: "offline", source: "probe", failures: Math.max(cur.failures, PASSIVE_OFFLINE_AFTER) };
  }
}

export interface ConnectivitySnapshot {
  state: ConnState;
  since: string;
  source: ConnSource;
}

export type ProbeFn = (url: string, token: string | undefined, signal: AbortSignal) => Promise<boolean>;

const defaultProbe: ProbeFn = async (url, token, signal) => {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal, headers: token ? { authorization: `Bearer ${token}` } : {} });
    await res.body?.cancel();
    return true; // any HTTP response means the network path works
  } catch {
    return false;
  }
};

export interface ConnectivityOptions {
  clock: Clock;
  settings: SettingsService;
  events: EventBus;
  probe?: ProbeFn;
  onChange?: (snap: ConnectivitySnapshot) => void;
}

export class ConnectivityService {
  private observed: Observed = { state: "unknown", source: "passive", failures: 0 };
  private since: number;
  private timer?: NodeJS.Timeout;
  private lastPublished = "";
  private unsubscribe?: () => void;
  /** Number of probe requests started. Zero for ever when no probe URL is configured. */
  probeCount = 0;

  constructor(private readonly o: ConnectivityOptions) {
    this.since = o.clock.now();
  }

  get forced(): boolean {
    return this.o.settings.internal("offline").forced;
  }

  snapshot(): ConnectivitySnapshot {
    if (this.forced) return { state: "offline", since: new Date(this.since).toISOString(), source: "forced" };
    return { state: this.observed.state, since: new Date(this.since).toISOString(), source: this.observed.source };
  }

  /** Report the outcome of a real outbound request. `network: true` means it never reached a server. */
  recordOutcome(outcome: { ok: boolean; network?: boolean }): void {
    this.apply(outcome.ok || outcome.network === false ? { type: "success" } : { type: "network_failure" });
  }

  private apply(e: ConnEvent): void {
    this.observed = reduceConnectivity(this.observed, e);
    this.publishIfChanged();
  }

  private publishIfChanged(): void {
    const snap = this.snapshot();
    const key = `${snap.state}|${snap.source}`;
    if (key === this.lastPublished) return;
    if (this.lastPublished !== "") this.since = this.o.clock.now();
    this.lastPublished = key;
    const out = this.snapshot();
    this.o.events.publish("connectivity", out);
    this.o.onChange?.(out);
  }

  /** Persists the "work offline" switch through the settings service so it survives restarts. */
  setForced(forced: boolean, userId?: number): ConnectivitySnapshot {
    if (this.forced !== forced) this.o.settings.patch({ offline: { forced } }, userId);
    this.publishIfChanged();
    return this.snapshot();
  }

  /**
   * Throws a typed `offline` error when a call to the internet must not be made. Forced offline refuses
   * everything. Background work (crawling, discovery, providers) also refuses when passive observation
   * says offline; a user-initiated fetch is still allowed to try and fail fast.
   */
  assertCanReachInternet(opts: { background?: boolean } = {}): void {
    if (this.forced) {
      throw new AppError("offline", "Work offline is switched on, so nothing is fetched from the web. Switch it off to go online.", {
        canQueue: true,
        reason: "forced_offline",
      });
    }
    if (opts.background && this.observed.state === "offline") {
      throw new AppError("offline", "The server cannot reach the internet right now. This will be tried again when the connection returns.", {
        canQueue: true,
        reason: "offline",
      });
    }
  }

  // ---- optional probe ------------------------------------------------------------------------

  start(): void {
    this.stop();
    this.lastPublished = `${this.snapshot().state}|${this.snapshot().source}`;
    this.unsubscribe = this.o.settings.onChange((group) => {
      if (group === "offline") {
        this.publishIfChanged();
        this.schedule();
      }
    });
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const { probeUrl, probeIntervalSeconds } = this.o.settings.internal("offline");
    if (!probeUrl) return; // no probe URL: no outbound traffic from here, ever
    this.timer = setTimeout(() => void this.probeNow().finally(() => this.schedule()), probeIntervalSeconds * 1000);
    this.timer.unref();
  }

  /** Runs the probe once. Returns undefined (and does nothing) when no probe URL is configured or work-offline is on. */
  async probeNow(): Promise<boolean | undefined> {
    const { probeUrl } = this.o.settings.internal("offline");
    if (!probeUrl || this.forced) return undefined;
    this.probeCount++;
    const token = this.o.settings.secret("offline", "probeToken");
    const ok = await (this.o.probe ?? defaultProbe)(probeUrl, token, AbortSignal.timeout(5000));
    this.apply({ type: "probe", ok });
    return ok;
  }
}
