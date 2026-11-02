import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { LOG_AREAS, LOG_LEVELS, isPublicId } from "@ncb/shared";
import type { ServerState, Services } from "../context.js";
import { admin, iso } from "../lib/http.js";
import { formatSse } from "../services/events.js";
import { VERSION } from "../version.js";
import { MAX_SCRYPT, scryptStats } from "../lib/password.js";
import type { ZodTypeProvider } from "../lib/zod.js";
import { parseOrThrow } from "../lib/zod.js";

export interface WorkerStatus {
  name: "runner" | "extract" | "index" | "search" | "zim" | "renderer";
  state: "idle" | "busy" | "down" | "disabled";
  lastHeartbeatAt?: string;
  currentJobId?: string;
  memoryMb?: number;
}

export function workerStatuses(svc: Services): WorkerStatus[] {
  const slots = svc.runner.poolStatus();
  const runner: WorkerStatus = {
    name: "runner",
    state: !svc.runner.claiming ? "down" : svc.runner.running > 0 ? "busy" : "idle",
    ...(svc.runner.lastTick ? { lastHeartbeatAt: iso(svc.runner.lastTick)! } : {}),
  };
  let extract: WorkerStatus;
  if (slots.length === 0) extract = { name: "extract", state: "disabled" };
  else {
    const busy = slots.find((s) => s.state === "busy" && s.currentJobId !== null);
    const live = slots.some((s) => s.state === "idle" || s.state === "busy" || s.state === "starting");
    const hb = Math.max(0, ...slots.map((s) => s.lastHeartbeatAt ?? 0));
    const mem = slots.reduce((n, s) => n + (s.memoryMb ?? 0), 0);
    extract = {
      name: "extract",
      state: !live ? "down" : slots.some((s) => s.state === "busy") ? "busy" : "idle",
      ...(hb ? { lastHeartbeatAt: iso(hb)! } : {}),
      ...(busy?.currentJobId != null ? { currentJobId: String(busy.currentJobId) } : {}),
      ...(mem ? { memoryMb: Math.round(mem * 10) / 10 } : {}),
    };
  }
  const off = (name: WorkerStatus["name"]): WorkerStatus => ({ name, state: "disabled" });
  const live = (name: WorkerStatus["name"]): WorkerStatus => (svc.search ? { name, state: svc.search.state === "building" || svc.search.state === "rebuilding" ? (name === "index" ? "busy" : "idle") : "idle" } : off(name));
  return [runner, extract, live("index"), live("search"), off("zim"), off("renderer")];
}

type Health = "ok" | "degraded" | "starting";

/** Database writable, workers alive, free space above the floor. (The index check joins in Phase 4.) */
export function computeHealth(state: ServerState): Health {
  if (state.phase === "starting") return "starting";
  if (!state.ready) return "degraded";
  const svc = state.svc;
  try {
    svc.db.get("SELECT 1 AS ok");
  } catch {
    return "degraded";
  }
  const slots = svc.runner.poolStatus();
  if (slots.length > 0) {
    const now = svc.clock.now();
    const alive = slots.some((s) => s.state === "starting" || (s.lastHeartbeatAt !== null && now - s.lastHeartbeatAt < 20_000));
    if (!alive) return "degraded";
  }
  const floor = svc.config.NCB_MIN_FREE_DISK_GB * 1024 ** 3;
  const def = svc.volumes.defaultVolume();
  if (def && def.state === "online" && def.statFree !== null && def.statFree < floor) return "degraded";
  return "ok";
}

const csv = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = parts.find((p) => !(values as readonly string[]).includes(p));
      if (bad) {
        ctx.addIssue({ code: "custom", message: `"${bad}" is not one of ${values.join(", ")}` });
        return z.NEVER;
      }
      return parts as T[];
    });

const isoDate = z.iso.datetime({ offset: true }).optional();

const logsQuery = z.object({
  level: csv(LOG_LEVELS),
  area: csv(LOG_AREAS),
  downloadJobId: z.string().optional(),
  from: isoDate,
  to: isoDate,
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d+$/, "Use the cursor from the previous page").optional(),
});

interface LogRow {
  id: number; at: number; level: string; area: string; message: string; details_json: string | null;
  download_job_id: number | null; job_id: number | null; version_id: number | null; dl_public: string | null;
}

export function systemRoutes(app: FastifyInstance, state: ServerState, o: { sseHeartbeatMs: number; proxyVerified: (r: FastifyRequest) => boolean }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/system/health", { config: { auth: "public" } }, async (_req, reply) => {
    const status = computeHealth(state);
    if (status === "starting") void reply.code(503);
    return { status };
  });

  r.get("/api/system/status", { config: { auth: "session" } }, async () => {
    const svc = state.svc;
    const mem = process.memoryUsage();
    const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
    return {
      version: VERSION,
      architecture: process.arch,
      node: process.version,
      startedAt: new Date(state.startedAt).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      profile: svc.settings.internal("resources").profile,
      authMode: svc.guestMatcher ? "trusted-lan" : "password",
      workers: workerStatuses(svc),
      workerPool: svc.runner.poolStatus().map((s) => ({
        id: s.id,
        state: s.state,
        ...(s.currentJobId !== null ? { currentJobId: String(s.currentJobId) } : {}),
        ...(s.lastHeartbeatAt ? { lastHeartbeatAt: iso(s.lastHeartbeatAt) } : {}),
        ...(s.memoryMb !== null ? { memoryMb: s.memoryMb } : {}),
        restarts: s.restarts,
        ...(s.lastError ? { lastError: s.lastError } : {}),
      })),
      queues: svc.queue.counts(),
      memory: { rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed) },
      connectivity: svc.connectivity.snapshot(),
      renderer: { reachable: false },
      migrations: svc.main.migration.applied,
      scrypt: { max: MAX_SCRYPT, ...scryptStats() },
    };
  });

  r.get("/api/system/dashboard", { config: { auth: "session" } }, async () => {
    const svc = state.svc;
    const num = (sql: string, params: (string | number)[] = []) => svc.db.get<{ n: number }>(sql, params)?.n ?? 0;
    const volumes = svc.volumes.list();
    let used = 0;
    let available = 0;
    for (const v of volumes) {
      used += svc.volumes.usedBytes(v.id);
      if (v.state === "online" || v.state === "readonly" || v.state === "draining") available += svc.volumes.toDto(v).availableBytes;
    }
    const byPriority = () => {
      const out = { P1: 0, P2: 0, P3: 0, P4: 0 };
      for (const i of svc.storage.usage.compute("priority").items) out[(i.key === "unreferenced" ? "P4" : i.key) as keyof typeof out] += i.exclusiveBytes + i.sharedBytes;
      return out;
    };
    const counts = svc.queue.counts();
    const sum = (state: string) => Object.values(counts).reduce((n, q) => n + ((q as Record<string, number>)[state] ?? 0), 0);
    const lastDone = svc.db.get<{ t: number | null }>("SELECT MAX(finished_at) AS t FROM jobs WHERE state = 'done'")?.t ?? null;
    return {
      // Pages, sources, collections and the index arrive in Phases 2 to 4; their counters are zero until then.
      pages: {
        total: num("SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL"),
        archived: num("SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL AND availability = 'archived'"),
        partial: num("SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL AND availability = 'partial'"),
        evicted: num("SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL AND availability = 'evicted'"),
      },
      sources: { total: num("SELECT COUNT(*) AS n FROM sources WHERE deleted_at IS NULL"), enabled: num("SELECT COUNT(*) AS n FROM sources WHERE deleted_at IS NULL AND enabled = 1") },
      collections: num("SELECT COUNT(*) AS n FROM collections WHERE deleted_at IS NULL"),
      index: svc.search.indexStatusSimple(),
      storage: { usedBytes: used, availableBytes: available, byPriority: byPriority() },
      jobs: {
        active: sum("running"),
        queued: sum("queued") + sum("held"),
        failedLast24h: num("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('failed','dead') AND finished_at > ?", [svc.clock.now() - 86_400_000]),
      },
      ...(lastDone ? { lastUpdateAt: iso(lastDone) } : {}),
      workers: workerStatuses(svc),
      connectivity: svc.connectivity.snapshot().state,
    };
  });

  // ---- verify and repair (Phase 6, T-10) -----------------------------------------------------------

  r.post(
    "/api/system/maintenance/verify",
    { config: { auth: "session" }, schema: { body: z.object({ repair: z.boolean().default(false), checks: z.array(z.string().max(8)).max(14).optional() }).default({ repair: false }) } },
    async (req) => {
      admin(req);
      return state.svc.storage.maintenance.verify({ repair: req.body.repair, checks: req.body.checks });
    },
  );

  r.get("/api/system/maintenance/runs", { config: { auth: "session" }, schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async (req) =>
    state.svc.storage.maintenance.list(req.query.limit),
  );

  r.get("/api/system/maintenance/runs/:id", { config: { auth: "session" }, schema: { params: z.object({ id: z.string().refine((v) => isPublicId(v, "mnt"), "Not a maintenance run id") }) } }, async (req) =>
    state.svc.storage.maintenance.get(req.params.id),
  );

  /** `VACUUM INTO` a backup of `main.db` under the data directory. */
  r.post("/api/system/maintenance/backup", { config: { auth: "session" } }, async (req) => {
    const svc = state.svc;
    const user = admin(req);
    const dir = path.join(svc.config.NCB_DATA_DIR, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(svc.clock.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const dest = path.join(dir, `main-${stamp}.db`);
    svc.db.backupTo(dest);
    svc.activity.write({ level: "info", area: "storage", message: "Database backup written", details: { file: path.basename(dest) }, userId: user.userId });
    return { file: path.basename(dest), sizeBytes: fs.statSync(dest).size };
  });

  r.get("/api/system/logs", { config: { auth: "session" }, schema: { querystring: logsQuery } }, async (req) => {
    const svc = state.svc;
    const q = req.query;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.level?.length) {
      where.push(`a.level IN (${q.level.map(() => "?").join(",")})`);
      args.push(...q.level);
    }
    if (q.area?.length) {
      where.push(`a.area IN (${q.area.map(() => "?").join(",")})`);
      args.push(...q.area);
    }
    if (q.downloadJobId) {
      if (!isPublicId(q.downloadJobId, "dl")) return { items: [] };
      const dl = svc.db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [q.downloadJobId]);
      if (!dl) return { items: [] };
      where.push("a.download_job_id = ?");
      args.push(dl.id);
    }
    if (q.from) {
      where.push("a.at >= ?");
      args.push(Date.parse(q.from));
    }
    if (q.to) {
      where.push("a.at <= ?");
      args.push(Date.parse(q.to));
    }
    if (q.q) {
      where.push("instr(lower(a.message), lower(?)) > 0");
      args.push(q.q);
    }
    if (q.cursor) {
      where.push("a.id < ?");
      args.push(Number(q.cursor));
    }
    const rows = svc.db.all<LogRow>(
      `SELECT a.*, d.public_id AS dl_public FROM activity_log a LEFT JOIN download_jobs d ON d.id = a.download_job_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ?`,
      [...args, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((x) => ({
        id: x.id,
        at: iso(x.at)!,
        level: x.level,
        area: x.area,
        message: x.message,
        ...(x.details_json ? { details: JSON.parse(x.details_json) as unknown } : {}),
        ...(x.dl_public ? { downloadJobId: x.dl_public } : {}),
        ...(x.job_id !== null ? { jobId: String(x.job_id) } : {}),
        ...(x.version_id !== null ? { versionId: String(x.version_id) } : {}),
      })),
      ...(rows.length > q.limit ? { nextCursor: String(page[page.length - 1]!.id) } : {}),
    };
  });

  r.get("/api/system/connectivity", { config: { auth: "guest" } }, async () => state.svc.connectivity.snapshot());

  r.post(
    "/api/system/connectivity",
    { config: { auth: "session" }, schema: { body: z.object({ forceOffline: z.boolean() }) } },
    async (req) => {
      const svc = state.svc;
      const user = admin(req);
      const before = svc.connectivity.forced;
      const snap = svc.connectivity.setForced(req.body.forceOffline, user.userId);
      if (before !== req.body.forceOffline) {
        svc.activity.write({ level: "info", area: "system", message: req.body.forceOffline ? "Work offline switched on" : "Work offline switched off", userId: user.userId });
      }
      return snap;
    },
  );

  // ---- server-sent events -------------------------------------------------------------------

  r.get("/api/system/events", { config: { auth: "session" } }, async (req, reply) => {
    const svc = state.svc;
    parseOrThrow(z.object({}), req.query, "query");
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": req.id,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
    res.write("retry: 3000\n\n");

    const lastRaw = req.headers["last-event-id"];
    const last = Number(Array.isArray(lastRaw) ? lastRaw[0] : lastRaw);
    if (Number.isFinite(last)) {
      for (const e of svc.events.since(last)) res.write(formatSse(e));
    } else {
      // A fresh connection starts from the current state, then follows changes.
      res.write(formatSse({ type: "connectivity", data: svc.connectivity.snapshot() }));
      res.write(formatSse({ type: "workers", data: workerStatuses(svc) }));
    }

    const unsubscribe = svc.events.subscribe((e) => {
      if (!res.writableEnded) res.write(formatSse(e));
    });
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(": heartbeat\n\n");
    }, o.sseHeartbeatMs);
    const handle = { end: () => { if (!res.writableEnded) res.end(); } };
    state.streams.add(handle);
    const cleanup = () => {
      clearInterval(beat);
      unsubscribe();
      state.streams.delete(handle);
    };
    res.on("close", cleanup);
    req.raw.on("close", cleanup);
  });

}
