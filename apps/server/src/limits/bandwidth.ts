import { Transform } from "node:stream";

/**
 * A global bandwidth limit shared by every response stream (a token bucket kept as "the time the next byte may be sent").
 * Each chunk asks `take(bytes)` and is held back for the returned number of milliseconds; the stream's back-pressure then slows
 * the socket. A burst of `burstMs` worth of bytes goes through at once so that small responses are not delayed.
 */
export class BandwidthLimiter {
  private bytesPerSecond = 0;
  private nextFree = 0;
  private sent = 0;

  constructor(private readonly now: () => number = () => performance.now(), private readonly burstMs = 100) {}

  /** 0 switches the limit off. */
  setRate(bytesPerSecond: number): void {
    const r = Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? Math.floor(bytesPerSecond) : 0;
    if (r !== this.bytesPerSecond) this.nextFree = 0;
    this.bytesPerSecond = r;
  }

  get rate(): number {
    return this.bytesPerSecond;
  }

  /** Bytes that have been let through while a limit was set. */
  get throttledBytes(): number {
    return this.sent;
  }

  /** Books `bytes` and returns how many milliseconds the caller must wait before passing them on. */
  take(bytes: number): number {
    if (this.bytesPerSecond <= 0 || bytes <= 0) return 0;
    const t = this.now();
    if (this.nextFree < t - this.burstMs) this.nextFree = t - this.burstMs;
    this.nextFree += (bytes / this.bytesPerSecond) * 1000;
    this.sent += bytes;
    return Math.max(0, this.nextFree - t);
  }

  /** A pass-through stream that obeys the limit. Returns undefined while no limit is set. */
  transform(): Transform | undefined {
    if (this.bytesPerSecond <= 0) return undefined;
    let timer: NodeJS.Timeout | undefined;
    return new Transform({
      highWaterMark: 16 * 1024,
      transform: (chunk: Buffer, _enc, cb) => {
        const wait = this.take(chunk.length);
        if (wait < 1) return cb(null, chunk);
        timer = setTimeout(() => {
          timer = undefined;
          cb(null, chunk);
        }, wait);
      },
      destroy(err, cb) {
        if (timer) clearTimeout(timer);
        cb(err);
      },
    });
  }
}
