import os from "node:os";
import type { Clock } from "@ncb/shared";
import type { ActivityLog } from "../services/activity.js";
import type { EventBus } from "../services/events.js";
import type { SettingsService } from "../services/settings.js";
import type { VolumeRow, VolumeService } from "../services/volumes.js";
import { BandwidthLimiter } from "./bandwidth.js";
import { THROTTLE_THRESHOLDS, type CpuThrottleLevel, type ResourceProfileName } from "./presets.js";

/** The `ResourceLimits` of docs/api.md section 8. */
export interface ResourceLimits {
  fetchConcurrency: number;
  perHostConcurrency: number;
  perHostDelayMs: number;
  bandwidthKbps?: number;
  workerMemoryMb: number;
  extractWorkers: number;
  renderConcurrency: number;
  cpuThrottle: CpuThrottleLevel;
  minFreeDiskBytes: number;
  profile: ResourceProfileName;
  effectiveFetchConcurrency: number;
}

export interface ThrottleStatus {
  active: boolean;
  level: CpuThrottleLevel;
  reason?: "event_loop_lag" | "load_average";
  lagMs: number;
  loadPerCore: number;
  since?: string;
}

export interface DiskGuardStatus {
  paused: boolean;
  volumes: { id: string; name: string; freeBytes: number; reserveFreeBytes: number; low: boolean }[];
  pausedDownloads: number;
}

/** What the disk guard asks of the downloads: pause everything that is not a Human's single save, and let it go again. */
export interface DiskGuardTarget {
  pauseForLimit(): number;
  resumeFromLimit(): number;
  countPausedByLimit(): number;
}

export interface GovernorOptions {
  clock: Clock;
  settings: Pick<SettingsService, "internal" | "onChange">;
  volumes: Pick<VolumeService, "list" | "statNow">;
  events: EventBus;
  activity: ActivityLog;
  log?: { warn(o: unknown, m?: string): void };
  /** Event-loop lag in milliseconds since the last read (tests inject a synthetic source). */
  lagSource?: () => number;
  /** One-minute load average per core (tests inject a synthetic source). */
  loadSource?: () => number;
  /** How often the CPU guard samples. Default 1000 ms. */
  cpuTickMs?: number;
  /** How often the disk guard looks at free space. Default 5000 ms. */
  diskTickMs?: number;
}

/** Measures how late a timer fires: the extra delay is time the event loop spent busy. Returns the worst lag since the last read. */
class LagSampler {
  private worst = 0;
  private timer?: NodeJS.Timeout;
  private expected = 0;

  constructor(private readonly resolutionMs = 25) {}

  start(): void {
    this.expected = performance.now() + this.resolutionMs;
    this.timer = setInterval(() => {
      const t = performance.now();
      this.worst = Math.max(this.worst, t - this.expected);
      this.expected = t + this.resolutionMs;
    }, this.resolutionMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  read(): number {
    const w = this.worst;
    this.worst = 0;
    return Math.round(Math.max(0, w));
  }
}

/**
 * Resource limits in one place (task C-10): the global fetch concurrency the runner uses, the per-host limits the queue claim
 * uses, the bandwidth limiter every response stream shares, the CPU guard (lowers concurrency while the event loop lags or the
 * machine is loaded) and the disk guard (pauses background downloads under the volume reserve).
 */
export class ResourceGovernor {
  readonly bandwidth = new BandwidthLimiter();
  private throttled: { reason: "event_loop_lag" | "load_average"; since: number } | undefined;
  private severe = false;
  private lastLag = 0;
  private lastLoad = 0;
  private readonly sampler = new LagSampler();
  private cpuTimer?: NodeJS.Timeout;
  private diskTimer?: NodeJS.Timeout;
  private diskLow = false;
  private diskVolumes: DiskGuardStatus["volumes"] = [];
  private diskBusy = false;
  private target?: DiskGuardTarget;
  private unsubscribe?: () => void;
  private readonly cores = Math.max(1, os.cpus().length);

  constructor(private readonly o: GovernorOptions) {
    this.applyBandwidth();
    this.unsubscribe = o.settings.onChange((group) => {
      if (group === "resources") this.applyBandwidth();
    });
  }

  setDiskTarget(t: DiskGuardTarget): void {
    this.target = t;
  }

  private get res() {
    return this.o.settings.internal("resources");
  }

  private applyBandwidth(): void {
    // The setting is kilobits per second; the limiter counts bytes per second.
    this.bandwidth.setRate((this.res.bandwidthLimitKbps * 1000) / 8);
  }

  // ---- limits the rest of the server reads ---------------------------------------------------

  /** Global concurrency for fetch and process work after CPU throttling. */
  fetchConcurrency(): number {
    const base = this.res.maxFetchConcurrency;
    if (!this.throttled) return base;
    return this.severe ? 1 : Math.max(1, Math.ceil(base / 2));
  }

  /** Per-host cap and floor for the delay between requests, read by the queue claim. */
  hostLimits(): { maxConcurrent: number; minDelayMs: number } {
    return { maxConcurrent: this.res.perHostConcurrency, minDelayMs: this.res.perHostDelayMs };
  }

  limits(): ResourceLimits {
    const r = this.res;
    const reserve = Math.max(0, ...this.o.volumes.list().map((v) => v.reserveFreeBytes));
    return {
      fetchConcurrency: r.maxFetchConcurrency, perHostConcurrency: r.perHostConcurrency, perHostDelayMs: r.perHostDelayMs,
      ...(r.bandwidthLimitKbps > 0 ? { bandwidthKbps: r.bandwidthLimitKbps } : {}),
      workerMemoryMb: r.workerMemoryMb, extractWorkers: r.extractWorkers, renderConcurrency: r.renderConcurrency, cpuThrottle: r.cpuThrottle,
      minFreeDiskBytes: reserve, profile: r.profile, effectiveFetchConcurrency: this.fetchConcurrency(),
    };
  }

  throttleStatus(): ThrottleStatus {
    return {
      active: !!this.throttled, level: this.res.cpuThrottle, ...(this.throttled ? { reason: this.throttled.reason, since: new Date(this.throttled.since).toISOString() } : {}),
      lagMs: this.lastLag, loadPerCore: Math.round(this.lastLoad * 100) / 100,
    };
  }

  diskStatus(): DiskGuardStatus {
    return { paused: this.diskLow, volumes: this.diskVolumes, pausedDownloads: this.target?.countPausedByLimit() ?? 0 };
  }

  // ---- CPU guard -----------------------------------------------------------------------------

  /** One sample of the CPU guard. Called by the timer; tests call it with synthetic sources. */
  cpuTick(): void {
    const level = this.res.cpuThrottle;
    const lag = (this.o.lagSource ?? (() => this.sampler.read()))();
    const load = (this.o.loadSource ?? (() => os.loadavg()[0]! / this.cores))();
    this.lastLag = lag;
    this.lastLoad = load;
    const before = this.fetchConcurrency();
    const wasThrottled = !!this.throttled;
    if (level === "off") {
      this.throttled = undefined;
      this.severe = false;
    } else {
      const th = THROTTLE_THRESHOLDS[level];
      const lagHigh = lag > th.lagMs;
      const loadHigh = load > th.loadPerCore;
      if (lagHigh || loadHigh) {
        this.throttled ??= { reason: lagHigh ? "event_loop_lag" : "load_average", since: this.o.clock.now() };
        this.severe = lag > th.lagMs * 3 || load > th.loadPerCore * 1.5;
      } else if (this.throttled && lag < th.lagMs * 0.5 && load < th.loadPerCore * 0.8) {
        this.throttled = undefined;
        this.severe = false;
      }
    }
    if (wasThrottled !== !!this.throttled || before !== this.fetchConcurrency()) {
      const on = !!this.throttled;
      this.o.activity.write({
        level: "info", area: "system",
        message: on
          ? `Background downloads slowed to ${this.fetchConcurrency()} at a time because the server is busy (${this.throttled!.reason === "event_loop_lag" ? `${lag} ms delay` : `load ${load.toFixed(1)} per core`}).`
          : "The server is no longer busy, so downloads are back to full speed.",
        details: { lagMs: lag, loadPerCore: load, concurrency: this.fetchConcurrency() },
      });
      this.publishQueue();
    }
  }

  // ---- disk guard ----------------------------------------------------------------------------

  private writable(v: VolumeRow): boolean {
    return v.state === "online";
  }

  /**
   * Looks at free space on every online volume. When none has room above its reserve, background downloads are paused
   * (`volume_full`); when any does again, the ones the guard paused are resumed. Phase 6 evicts; this only pauses.
   */
  async diskTick(): Promise<void> {
    if (this.diskBusy) return;
    this.diskBusy = true;
    try {
      const rows: DiskGuardStatus["volumes"] = [];
      let anyRoom = false;
      let any = false;
      for (const v of this.o.volumes.list()) {
        const stat = await this.o.volumes.statNow(v);
        const free = stat?.free ?? v.statFree ?? 0;
        const low = free < v.reserveFreeBytes;
        const fresh = v;
        rows.push({ id: fresh.publicId, name: fresh.name, freeBytes: free, reserveFreeBytes: fresh.reserveFreeBytes, low });
        if (this.writable(fresh)) {
          any = true;
          if (!low) anyRoom = true;
        }
      }
      this.diskVolumes = rows;
      const shouldPause = any && !anyRoom;
      if (shouldPause && !this.diskLow) {
        this.diskLow = true;
        const n = this.target?.pauseForLimit() ?? 0;
        this.o.activity.write({
          level: "warn", area: "storage",
          message: `Free space is below the reserve, so ${n} background download${n === 1 ? " is" : "s are"} paused. They resume when space is available.`,
          details: { volumes: rows },
        });
        this.publishQueue();
      } else if (!shouldPause && this.diskLow) {
        this.diskLow = false;
        const n = this.target?.resumeFromLimit() ?? 0;
        this.o.activity.write({ level: "info", area: "storage", message: `Free space is back above the reserve. ${n} paused download${n === 1 ? "" : "s"} resumed.` });
        this.publishQueue();
      } else if (shouldPause && this.diskLow) {
        // New background work that arrived while the disk is full is held as well.
        this.target?.pauseForLimit();
      }
    } catch (e) {
      this.o.log?.warn({ err: String(e) }, "disk guard check failed");
    } finally {
      this.diskBusy = false;
    }
  }

  private statusListener?: () => void;

  /** The downloads service adds the counts and publishes `download.queue`. */
  onStatusChange(fn: () => void): void {
    this.statusListener = fn;
  }

  publishQueue(): void {
    if (this.statusListener) this.statusListener();
    else this.o.events.publish("download.queue", { throttle: this.throttleStatus(), disk: this.diskStatus() });
  }

  start(): void {
    this.sampler.start();
    this.cpuTimer = setInterval(() => this.cpuTick(), this.o.cpuTickMs ?? 1000);
    this.cpuTimer.unref();
    this.diskTimer = setInterval(() => void this.diskTick(), this.o.diskTickMs ?? 5000);
    this.diskTimer.unref();
    void this.diskTick();
  }

  stop(): void {
    this.sampler.stop();
    if (this.cpuTimer) clearInterval(this.cpuTimer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.cpuTimer = this.diskTimer = undefined;
    this.unsubscribe?.();
  }
}
