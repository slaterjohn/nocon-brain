import type { Clock } from "@ncb/shared";
import { systemClock } from "@ncb/shared";

export const THROTTLE_MAX_KEYS = 10_000;

export interface ThrottleLimits {
  perIpPerMinute: number;
  perUserPerHour: number;
}

/**
 * In-memory login throttle: 5 attempts a minute per IP and 20 an hour per username (docs/api.md).
 * `check()` records the attempt straight away, before the slow password hash, so concurrent requests
 * cannot all slip under the limit. `clear()` forgives the attempts after a successful sign-in.
 */
export class LoginThrottle {
  private byIp = new Map<string, number[]>();
  private byUser = new Map<string, number[]>();
  private lastSweep = 0;
  private readonly clock: Clock;
  private readonly limits: ThrottleLimits;

  constructor(clock: Clock = systemClock, limits: Partial<ThrottleLimits> = {}) {
    this.clock = clock;
    this.limits = { perIpPerMinute: 5, perUserPerHour: 20, ...limits };
  }

  private prune(list: number[] | undefined, windowMs: number): number[] {
    const cutoff = this.clock.now() - windowMs;
    return (list ?? []).filter((t) => t > cutoff);
  }

  private sweep(map: Map<string, number[]>, windowMs: number): void {
    const cutoff = this.clock.now() - windowMs;
    for (const [k, v] of map) if (!v.length || v[v.length - 1]! <= cutoff) map.delete(k);
    for (const k of map.keys()) {
      if (map.size < THROTTLE_MAX_KEYS) break;
      map.delete(k); // a flood of fresh keys: drop the oldest-inserted ones
    }
  }

  private maintain(): void {
    const now = this.clock.now();
    if (this.byIp.size < THROTTLE_MAX_KEYS && this.byUser.size < THROTTLE_MAX_KEYS && now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    this.sweep(this.byIp, 60_000);
    this.sweep(this.byUser, 3_600_000);
  }

  /** Returns seconds to wait (0 = allowed, and the attempt has been recorded). */
  check(ip: string, username: string): number {
    this.maintain();
    const now = this.clock.now();
    const u = username.toLowerCase();
    const a = this.prune(this.byIp.get(ip), 60_000);
    const b = this.prune(this.byUser.get(u), 3_600_000);
    let wait = 0;
    if (a.length >= this.limits.perIpPerMinute) wait = Math.ceil((a[0]! + 60_000 - now) / 1000);
    else if (b.length >= this.limits.perUserPerHour) wait = Math.ceil((b[0]! + 3_600_000 - now) / 1000);
    if (wait === 0) {
      a.push(now);
      b.push(now);
    }
    this.byIp.set(ip, a);
    this.byUser.set(u, b);
    return Math.max(wait, 0);
  }

  clear(ip: string, username: string): void {
    this.byIp.delete(ip);
    this.byUser.delete(username.toLowerCase());
  }

  size() {
    return { ips: this.byIp.size, users: this.byUser.size };
  }
}
