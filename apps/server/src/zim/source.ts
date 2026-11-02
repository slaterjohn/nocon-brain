import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork, type ChildProcess } from "node:child_process";
import { Worker } from "node:worker_threads";
import { AppError, type ErrorCode } from "@ncb/shared";
import type { EntryReply, FromZimWorker, SearchHit, SuggestHit, ToZimWorker, ZimMeta, ZimReply, ZimRequest, ZimWorkerData } from "./protocol.js";

export type { EntryReply, SearchHit, SuggestHit, ZimMeta } from "./protocol.js";

/** Whether a package can answer right now. `degraded` is set after a crash, a hang or a failed open and clears after the next good reply. */
export type ZimHealth = "ready" | "degraded" | "closed";

export interface QueryOptions {
  limit?: number;
  offset?: number;
  /** Soft time budget in ms. The worker returns what it has found when it runs out (`partial: true`). */
  budgetMs?: number;
}

export interface SuggestResult { hits: SuggestHit[]; estimated: number; partial: boolean }
export interface SearchResult { hits: SearchHit[]; estimated: number; partial: boolean }
export interface BrowseResult { items: { path: string; title: string }[]; next: string | null }
export interface CacheSizes { clusterMax: number; clusterCurrent: number; direntMax: number; direntCurrent: number }

/**
 * What the rest of the server needs from a ZIM reader (docs/research/zim-wikipedia.md section 2: keep the interface small so a
 * different implementation, for example a kiwix-serve sidecar, could sit behind it). Every call is bounded in time.
 */
export interface ZimSource {
  /** Opens (or reopens) a package and returns its metadata. A file that is not a valid ZIM rejects with `invalid_zim`. */
  open(id: string, file: string): Promise<ZimMeta>;
  close(id: string): Promise<void>;
  isOpen(id: string): boolean;
  health(id: string): ZimHealth;
  readEntry(id: string, entryPath: string, o?: { follow?: boolean }): Promise<EntryReply>;
  hasEntry(id: string, entryPath: string): Promise<boolean>;
  illustration(id: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
  suggest(id: string, query: string, o?: QueryOptions): Promise<SuggestResult>;
  search(id: string, query: string, o?: QueryOptions): Promise<SearchResult>;
  browse(id: string, o?: { after?: string; limit?: number }): Promise<BrowseResult>;
  cacheSizes(id: string): Promise<CacheSizes>;
  setCacheSizes(id: string, o: { clusterCache?: number; direntCache?: number }): Promise<CacheSizes>;
  verify(id: string, deep: boolean): Promise<{ ok: boolean; checks: string[] }>;
  shutdown(): Promise<void>;
}

/** A ZIM call that could not be answered. `code` is stable for callers: `timeout`, `worker_crashed`, `worker_hung`, `unavailable`, `invalid_zim`, `no_fulltext`. */
export class ZimError extends AppError {
  constructor(readonly zimCode: string, message: string, status: ErrorCode = "unavailable") {
    super(status, message, { zimCode });
  }
}

export interface WorkerZimSourceOptions {
  /**
   * `process` (default): each package is read by a forked child process. libzim turns some faults (a damaged file) into uncaught C++
   * exceptions that abort the process they run in, so only a separate process keeps such a fault away from the server. `thread` uses
   * `worker_threads` (lighter, but an abort takes the whole server down); it is meant for hosts where forking is not possible.
   */
  isolation?: "process" | "thread";
  /** A reader with nothing to do for this long is stopped to give its memory back; the next call starts it again. Default 300000 (5 minutes). */
  idleMs?: number;
  workerFile?: string | URL;
  workerExecArgv?: string[];
  /** libzim cluster cache in MiB (`NCB_ZIM_CACHE_MB`); about two MiB per cached cluster. */
  cacheMb?: number;
  /** A worker that has not answered this long after the soft budget is terminated and restarted. Default 2000. */
  hangGraceMs?: number;
  /** Hard limit for calls without a soft budget (entry reads, open, browse). Default 15000. */
  callTimeoutMs?: number;
  testHooks?: boolean;
  /** Called whenever a package's health changes. */
  onHealth?: (id: string, health: ZimHealth, detail?: string) => void;
  log?: { warn(o: unknown, m?: string): void };
}

/** One reader, whichever way it runs. */
interface Reader {
  post(m: ToZimWorker): void;
  /** Stops it at once. Resolves when it has gone. */
  kill(): Promise<void>;
}

interface Handle {
  id: string;
  file: string;
  worker?: Reader;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
  starting?: Promise<void>;
  seq: number;
  pending: Map<number, { resolve(r: ZimReply): void; reject(e: Error): void; timer: NodeJS.Timeout }>;
  health: ZimHealth;
  crashes: number[];
  closing: boolean;
  /** Set while an idle reader is being stopped on purpose. */
  reaping?: boolean;
}

function resolveWorker(name: string): { file: string; execArgv: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [here, path.join(here, "..")]) {
    const js = path.join(dir, `${name}.js`);
    if (fs.existsSync(js)) return { file: js, execArgv: [] };
  }
  return { file: path.join(here, `${name}.ts`), execArgv: ["--import", "tsx"] };
}

const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 5;

/** `ZimSource` over `worker_threads`: one worker per open package, started lazily and restarted after a crash or a hang. */
export class WorkerZimSource implements ZimSource {
  private readonly handles = new Map<string, Handle>();
  private readonly spec: { file: string; execArgv: string[] };
  private readonly clusters: number;
  private stopped = false;
  /** Counters for the status endpoint and the tests. */
  stats = { restarts: 0, crashes: 0, hangs: 0, timeouts: 0 };

  constructor(private readonly o: WorkerZimSourceOptions = {}) {
    this.spec = o.workerFile ? { file: String(o.workerFile), execArgv: o.workerExecArgv ?? [] } : resolveWorker("zim-worker");
    this.clusters = Math.max(1, Math.floor((o.cacheMb ?? 16) / 2));
  }

  private get grace(): number { return this.o.hangGraceMs ?? 2000; }
  private get callTimeout(): number { return this.o.callTimeoutMs ?? 15_000; }

  isOpen(id: string): boolean { return this.handles.has(id); }
  health(id: string): ZimHealth { return this.handles.get(id)?.health ?? "closed"; }

  private setHealth(h: Handle, health: ZimHealth, detail?: string): void {
    if (h.health === health) return;
    h.health = health;
    try { this.o.onHealth?.(h.id, health, detail); } catch { /* a listener must not break the reader */ }
  }

  // ---- worker lifecycle ----------------------------------------------------------------------

  private spawn(h: Handle): Promise<void> {
    if (h.starting) return h.starting;
    const data: ZimWorkerData = { path: h.file, clusterCache: this.clusters, direntCache: 4096, testHooks: this.o.testHooks };
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
    let reader!: Reader;
    const onMsg = (m: FromZimWorker): void => {
      if (m.t === "ready") resolveReady();
      else this.onMessage(h, m);
    };
    const onGone = (why: string): void => {
      rejectReady(new Error(`The package reader stopped while starting (${why}).`));
      this.onDeath(h, reader, why);
    };
    if (this.o.isolation === "thread") {
      const w = new Worker(this.spec.file, { workerData: data, execArgv: this.spec.execArgv });
      w.on("message", onMsg);
      w.on("error", (e) => onGone(`error: ${e.message}`));
      w.on("exit", (code) => onGone(`exit ${code}`));
      reader = { post: (m) => w.postMessage(m), kill: async () => { await w.terminate().catch(() => undefined); } };
    } else {
      const c: ChildProcess = fork(this.spec.file, [], {
        execArgv: this.spec.execArgv, serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, NCB_ZIM_WORKER_DATA: JSON.stringify(data) },
      });
      c.on("message", (m) => onMsg(m as FromZimWorker));
      c.on("error", (e) => onGone(`error: ${e.message}`));
      c.on("exit", (code, signal) => onGone(`exit ${code ?? signal}`));
      reader = {
        post: (m) => { if (c.connected) c.send(m); },
        kill: () => new Promise<void>((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null) return resolve();
          c.once("exit", () => resolve());
          c.kill("SIGKILL");
        }),
      };
    }
    h.worker = reader;
    h.starting = ready.finally(() => { h.starting = undefined; });
    h.starting.catch(() => undefined);
    return h.starting;
  }

  private onMessage(h: Handle, m: FromZimWorker): void {
    if (m.t !== "reply") return;
    const p = h.pending.get(m.id);
    if (!p) return; // answered after the caller gave up
    h.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) {
      if (h.health === "degraded") this.setHealth(h, "ready");
      p.resolve(m.reply);
    } else {
      const e = new ZimError(m.code ?? "failed", m.error, m.code === "invalid_zim" ? "bad_request" : "internal");
      p.reject(e);
    }
  }

  /** The reader is gone (crashed, killed or exited). Pending calls fail; the next call starts a fresh one. */
  private onDeath(h: Handle, w: Reader, why: string): void {
    if (h.worker !== w) return;
    h.worker = undefined;
    h.starting = undefined;
    if (h.idleTimer) { clearTimeout(h.idleTimer); h.idleTimer = undefined; }
    for (const [id, p] of h.pending) { clearTimeout(p.timer); p.reject(new ZimError("worker_crashed", "The package reader stopped. It will restart on the next request.")); h.pending.delete(id); }
    if (h.closing || this.stopped || h.reaping) { h.reaping = false; return; }
    const now = Date.now();
    h.crashes = h.crashes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    this.stats.crashes++;
    this.o.log?.warn({ zim: h.id, why }, "zim reader stopped");
    this.setHealth(h, "degraded", `The package reader stopped unexpectedly (${why}).`);
  }

  /** Takes a stuck reader out of service at once (so the next call starts a fresh one), then stops it. */
  private async kill(h: Handle, why: string): Promise<void> {
    const w = h.worker;
    if (!w) return;
    this.stats.restarts++;
    this.o.log?.warn({ zim: h.id, why }, "terminating zim reader");
    this.onDeath(h, w, why);
    await w.kill();
  }

  /** Stops readers that have been idle for a while. They are not degraded: they start again on the next call. */
  private armIdle(h: Handle): void {
    const idle = this.o.idleMs ?? 300_000;
    if (h.idleTimer) clearTimeout(h.idleTimer);
    h.idleTimer = setTimeout(() => {
      h.idleTimer = undefined;
      if (h.pending.size > 0 || !h.worker) return;
      if (Date.now() - h.lastUsed < idle) return this.armIdle(h);
      const w = h.worker;
      h.reaping = true;
      void w.kill().then(() => this.onDeath(h, w, "idle"));
    }, idle);
    h.idleTimer.unref();
  }

  private handle(id: string): Handle {
    const h = this.handles.get(id);
    if (!h) throw new ZimError("unavailable", "That knowledge package is not open.");
    return h;
  }

  private async call(h: Handle, req: ZimRequest, hardMs: number): Promise<ZimReply> {
    if (this.stopped) throw new ZimError("unavailable", "The server is shutting down.");
    const now = Date.now();
    if (!h.worker && h.crashes.filter((t) => now - t < CRASH_WINDOW_MS).length >= CRASH_LIMIT) {
      throw new ZimError("unavailable", "This package keeps stopping, so it is paused for a minute. Check the file is not damaged.");
    }
    try {
      if (h.starting) await h.starting;
      else if (!h.worker) await this.spawn(h);
    } catch (e) {
      this.setHealth(h, "degraded", e instanceof Error ? e.message : String(e));
      throw new ZimError("worker_crashed", "The package reader could not start.");
    }
    const worker = h.worker;
    if (!worker) throw new ZimError("worker_crashed", "The package reader stopped. It will restart on the next request.");
    h.lastUsed = Date.now();
    this.armIdle(h);
    return new Promise<ZimReply>((resolve, reject) => {
      const id = ++h.seq;
      const timer = setTimeout(() => {
        // Nothing answered in time: a synchronous libzim call is stuck. Only killing the thread frees it.
        h.pending.delete(id);
        this.stats.hangs++;
        reject(new ZimError("worker_hung", "The package took too long to answer, so its reader was restarted."));
        this.setHealth(h, "degraded", "The package reader stopped answering and was restarted.");
        void this.kill(h, "hung");
      }, hardMs);
      timer.unref();
      h.pending.set(id, { resolve, reject, timer });
      worker.post({ id, ...req } satisfies ToZimWorker);
    });
  }

  // ---- ZimSource -----------------------------------------------------------------------------

  async open(id: string, file: string): Promise<ZimMeta> {
    let h = this.handles.get(id);
    if (h && h.file !== file) { await this.close(id); h = undefined; }
    if (!h) {
      h = { id, file, seq: 0, pending: new Map(), health: "ready", crashes: [], closing: false, lastUsed: Date.now() };
      this.handles.set(id, h);
    }
    try {
      const r = await this.call(h, { op: "open" }, this.callTimeout);
      if (r.kind !== "meta") throw new ZimError("failed", "Unexpected reply from the package reader.", "internal");
      this.setHealth(h, "ready");
      return r.meta;
    } catch (e) {
      const bad = e instanceof ZimError ? e : new ZimError("invalid_zim", "This file could not be opened as a ZIM package.", "bad_request");
      if (bad.zimCode === "worker_hung") throw bad;
      // Anything else while opening (a refusal, or libzim aborting its process on a damaged file) means the file is not a usable ZIM.
      await this.close(id);
      throw new ZimError("invalid_zim", "This file is not a valid ZIM package, or it is damaged.", "bad_request");
    }
  }

  async close(id: string): Promise<void> {
    const h = this.handles.get(id);
    if (!h) return;
    h.closing = true;
    this.handles.delete(id);
    for (const [k, p] of h.pending) { clearTimeout(p.timer); p.reject(new ZimError("unavailable", "The package was closed.")); h.pending.delete(k); }
    if (h.idleTimer) clearTimeout(h.idleTimer);
    const w = h.worker;
    h.worker = undefined;
    await w?.kill();
  }

  async readEntry(id: string, entryPath: string, o: { follow?: boolean } = {}): Promise<EntryReply> {
    const r = await this.call(this.handle(id), { op: "entry", path: entryPath, follow: o.follow }, this.callTimeout);
    if (r.kind !== "entry") throw new ZimError("failed", "Unexpected reply from the package reader.", "internal");
    return r.entry;
  }

  async hasEntry(id: string, entryPath: string): Promise<boolean> {
    const r = await this.call(this.handle(id), { op: "has", path: entryPath }, this.callTimeout);
    return r.kind === "bool" && r.value;
  }

  async illustration(id: string): Promise<{ data: Uint8Array; mimeType: string } | null> {
    const r = await this.call(this.handle(id), { op: "illustration" }, this.callTimeout);
    return r.kind === "bytes" && r.data ? { data: r.data, mimeType: r.mimeType ?? "image/png" } : null;
  }

  async suggest(id: string, query: string, o: QueryOptions = {}): Promise<SuggestResult> {
    const budgetMs = o.budgetMs ?? 800;
    const r = await this.call(this.handle(id), { op: "suggest", query, limit: o.limit ?? 10, budgetMs }, budgetMs + this.grace);
    if (r.kind !== "suggest") throw new ZimError("failed", "Unexpected reply from the package reader.", "internal");
    return { hits: r.hits, estimated: r.estimated, partial: r.partial };
  }

  async search(id: string, query: string, o: QueryOptions = {}): Promise<SearchResult> {
    const budgetMs = o.budgetMs ?? 800;
    const r = await this.call(this.handle(id), { op: "search", query, limit: o.limit ?? 10, offset: o.offset ?? 0, budgetMs }, budgetMs + this.grace);
    if (r.kind !== "search") throw new ZimError("failed", "Unexpected reply from the package reader.", "internal");
    return { hits: r.hits, estimated: r.estimated, partial: r.partial };
  }

  async browse(id: string, o: { after?: string; limit?: number } = {}): Promise<BrowseResult> {
    const r = await this.call(this.handle(id), { op: "browse", after: o.after, limit: Math.min(200, Math.max(1, o.limit ?? 50)) }, this.callTimeout);
    if (r.kind !== "browse") throw new ZimError("failed", "Unexpected reply from the package reader.", "internal");
    return { items: r.items, next: r.next };
  }

  async cacheSizes(id: string): Promise<CacheSizes> {
    return this.setCacheSizes(id, {});
  }

  async setCacheSizes(id: string, o: { clusterCache?: number; direntCache?: number }): Promise<CacheSizes> {
    const r = await this.call(this.handle(id), { op: "cache", ...o }, this.callTimeout);
    if (r.kind !== "cache") throw new ZimError("failed", "Unexpected reply from the package reader.", "internal");
    const { kind: _k, ...sizes } = r;
    return sizes;
  }

  async verify(id: string, deep: boolean): Promise<{ ok: boolean; checks: string[] }> {
    const r = await this.call(this.handle(id), { op: "verify", deep }, deep ? 30 * 60_000 : this.callTimeout);
    if (r.kind !== "verify") throw new ZimError("failed", "Unexpected reply from the package reader.", "internal");
    return { ok: r.ok, checks: r.checks };
  }

  /** Test and diagnostics hook: runs a debug action in the worker (needs `testHooks`). */
  async debug(id: string, action: "crash" | "abort" | "hang" | "sleep", ms?: number, hardMs = this.callTimeout): Promise<void> {
    await this.call(this.handle(id), { op: "debug", action, ms }, hardMs);
  }

  /** Kills the worker of a package the hard way, as an out-of-memory kill would. The next call restarts it. */
  async killWorker(id: string): Promise<void> {
    const h = this.handle(id);
    const w = h.worker;
    if (!w) return;
    this.onDeath(h, w, "killed");
    await w.kill();
  }

  workerCount(): number {
    let n = 0;
    for (const h of this.handles.values()) if (h.worker) n++;
    return n;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.handles.keys()].map((id) => this.close(id)));
  }
}
