import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, isPublicId, priorityToCode, type PriorityNumber } from "@ncb/shared";
import { P2_PERMIT_WARNING } from "../services/settings.js";
import type { ServerState, Services } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

const priorityIn = z.union([z.enum(["P1", "P2", "P3", "P4"]).transform((p) => Number(p.slice(1)) as PriorityNumber), z.number().int().min(1).max(4).transform((n) => n as PriorityNumber)]);
const bool = z.preprocess((v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : v), z.boolean());
const pageParam = z.object({ id: z.string().refine((v) => isPublicId(v, "pg"), "Not a page id") });

const idParam = z.object({
  id: z.string().refine((v) => isPublicId(v, "vol"), "Not a volume id"),
});

export function storageRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/storage/volumes", { config: { auth: "session" } }, async () => {
    const svc = state.svc;
    const rows = await svc.volumes.refreshAll();
    return { items: rows.map((v) => svc.storage.volumeDto(v)) };
  });

  r.post(
    "/api/storage/volumes",
    {
      config: { auth: "session" },
      schema: {
        body: z.object({
          path: z.string().min(1).max(1024),
          name: z.string().trim().min(1, "Enter a name").max(100),
          quotaBytes: z.number().int().min(1).optional(),
          reserveFreeBytes: z.number().int().min(0).optional(),
          makeDefault: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const svc = state.svc;
      const user = admin(req);
      const { volume, warnings } = await svc.volumes.register(req.body);
      svc.activity.write({ level: "info", area: "storage", message: `Storage volume "${volume.name}" registered`, details: { path: volume.rootPath, warnings }, userId: user.userId });
      void reply.code(201);
      return { volume: svc.storage.volumeDto(volume), warnings };
    },
  );

  r.get("/api/storage/volumes/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    const svc = state.svc;
    const v = await svc.volumes.refresh(svc.volumes.require(req.params.id));
    const reservations = svc.db.all<{ download_job_id: number; reserved_bytes: number; written_bytes: number; expires_at: number }>(
      "SELECT download_job_id, reserved_bytes, written_bytes, expires_at FROM volume_reservations WHERE volume_id = ? AND expires_at > ?",
      [v.id, svc.clock.now()],
    );
    return {
      ...svc.storage.volumeDto(v),
      reservations: reservations.map((x) => ({
        downloadJobId: String(x.download_job_id),
        reservedBytes: x.reserved_bytes,
        writtenBytes: x.written_bytes,
        expiresAt: new Date(x.expires_at).toISOString(),
      })),
      blobCount: svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs WHERE volume_id = ?", [v.id])!.n,
    };
  });

  r.patch(
    "/api/storage/volumes/:id",
    {
      config: { auth: "session" },
      schema: {
        params: idParam,
        body: z.object({
          name: z.string().trim().min(1).max(100).optional(),
          quotaBytes: z.number().int().min(1).nullable().optional(),
          reserveFreeBytes: z.number().int().min(0).optional(),
          thresholds: z
            .object({
              softPct: z.number().int().min(1).max(100).optional(),
              evictStartPct: z.number().int().min(1).max(100).optional(),
              evictTargetPct: z.number().int().min(1).max(100).optional(),
            })
            .optional(),
          state: z.enum(["online", "readonly", "draining", "disabled"]).optional(),
          isDefault: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const svc = state.svc;
      const user = admin(req);
      const v = await svc.volumes.update(req.params.id, req.body);
      svc.activity.write({ level: "info", area: "storage", message: `Storage volume "${v.name}" updated`, details: req.body, userId: user.userId });
      return svc.storage.volumeDto(v);
    },
  );

  r.delete("/api/storage/volumes/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    const svc = state.svc;
    const user = admin(req);
    const v = svc.volumes.require(req.params.id);
    svc.volumes.remove(req.params.id);
    svc.activity.write({ level: "info", area: "storage", message: `Storage volume "${v.name}" removed`, userId: user.userId });
    return { ok: true };
  });

  r.post("/api/storage/volumes/:id/verify", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    const svc = state.svc;
    const user = admin(req);
    const report = await svc.volumes.verify(req.params.id);
    svc.activity.write({
      level: report.markerOk && report.missingBlobs === 0 ? "info" : "warn",
      area: "storage",
      message: `Verified volume "${report.volume.name}": ${report.missingBlobs} missing of ${report.checkedBlobs} checked`,
      details: { markerOk: report.markerOk, writable: report.writable },
      userId: user.userId,
    });
    return report;
  });

  r.post("/api/storage/volumes/:id/migrate", { config: { auth: "session" }, schema: { params: idParam } }, async () => {
    throw new AppError("not_implemented", "Moving data between volumes is planned for a later release.");
  });

  // ---- Phase 6: overview, usage, policy, planning, forecast, explanation -----------------------------

  r.get("/api/storage", { config: { auth: "guest" } }, async () => {
    const svc = state.svc;
    const rows = await svc.volumes.refreshAll();
    const volumes = rows.map((v) => svc.storage.volumeDto(v));
    const policy = policyOut(svc);
    const byPriority = svc.storage.usage.compute("priority");
    const bySource = svc.storage.usage.compute("source");
    const lastRun = svc.db.get<{ public_id: string; trigger: string; state: string; versions_evicted: number; bytes_freed: number; started_at: number; finished_at: number | null }>(
      "SELECT public_id, trigger, state, versions_evicted, bytes_freed, started_at, finished_at FROM eviction_runs ORDER BY id DESC LIMIT 1");
    const lastVerify = svc.db.get<{ public_id: string; kind: string; dry_run: number; started_at: number }>(
      "SELECT public_id, kind, dry_run, started_at FROM maintenance_runs WHERE kind IN ('verify','repair') ORDER BY id DESC LIMIT 1");
    const online = rows.filter((v) => v.state === "online");
    return {
      volumes,
      totals: {
        capacityBytes: volumes.reduce((n, v) => n + v.capacityBytes, 0),
        usedBytes: byPriority.totalBytes,
        availableBytes: volumes.filter((v) => v.state === "online").reduce((n, v) => n + v.availableBytes, 0),
        reservedBytes: volumes.reduce((n, v) => n + v.reservedBytes, 0),
        unreferencedBytes: byPriority.unreferencedBytes,
      },
      usageByPriority: byPriority.items,
      usageBySource: bySource.items.slice(0, 20),
      forecast: svc.storage.forecast(),
      policy,
      eviction: {
        autoEviction: policy.autoEviction,
        throttling: online.some((v) => policy.throttleOpportunistic && svc.storage.usedPct(v) >= v.softThresholdPct),
        overThreshold: online.filter((v) => svc.storage.usedPct(v) >= v.evictStartPct).map((v) => v.publicId),
        ...(lastRun ? { lastRun: { id: lastRun.public_id, trigger: lastRun.trigger, state: lastRun.state, versionsEvicted: lastRun.versions_evicted, bytesFreed: lastRun.bytes_freed, startedAt: new Date(lastRun.started_at).toISOString() } } : {}),
      },
      maintenance: lastVerify ? { lastRun: { id: lastVerify.public_id, kind: lastVerify.kind, dryRun: lastVerify.dry_run === 1, startedAt: new Date(lastVerify.started_at).toISOString() } } : {},
      computedAt: byPriority.computedAt,
    };
  });

  r.get(
    "/api/storage/usage",
    {
      config: { auth: "guest" },
      schema: { querystring: z.object({ by: z.enum(["priority", "source", "kind", "volume"]).default("priority"), volumeId: z.string().optional(), fresh: bool.optional() }) },
    },
    async (req) => {
      const svc = state.svc;
      const v = req.query.volumeId ? svc.volumes.require(req.query.volumeId) : undefined;
      return svc.storage.usage.compute(req.query.by, v?.id, v?.publicId);
    },
  );

  r.get(
    "/api/storage/forecast",
    { config: { auth: "guest" }, schema: { querystring: z.object({ sourceId: z.string().max(64).optional(), horizonDays: z.coerce.number().int().min(7).max(365).optional() }) } },
    async (req) => state.svc.storage.forecast(req.query),
  );

  r.get("/api/storage/policy", { config: { auth: "session" } }, async () => policyOut(state.svc));

  r.put(
    "/api/storage/policy",
    {
      config: { auth: "session" },
      schema: {
        body: z.object({
          permitImportantEviction: z.boolean().optional(),
          throttleOpportunistic: z.boolean().optional(),
          pruneSurplusVersions: z.boolean().optional(),
          orphanGraceSeconds: z.number().int().min(0).max(31_536_000).optional(),
          autoEviction: z.boolean().optional(),
          maxEvictionBatchBytes: z.number().int().min(1).nullable().optional(),
          forecastHorizonDays: z.number().int().min(7).max(365).optional(),
          scrubMegabytesPerRun: z.number().int().min(0).max(4096).optional(),
          /** Required, and true, when turning `permitImportantEviction` on. */
          acknowledged: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const svc = state.svc;
      const user = admin(req);
      const { acknowledged, ...rest } = req.body;
      svc.settings.patch({ storage: { ...rest, ...(rest.permitImportantEviction === true ? { acknowledged: acknowledged === true } : {}) } }, user.userId);
      svc.activity.write({ level: "info", area: "storage", message: "Storage policy changed", details: rest, userId: user.userId });
      return policyOut(svc);
    },
  );

  r.post(
    "/api/storage/eviction/plan",
    {
      config: { auth: "session" },
      schema: {
        body: z.object({
          bytesNeeded: z.number().int().min(0).optional(),
          incomingPriority: priorityIn.optional(),
          volumeId: z.string().optional(),
          mode: z.enum(["pressure", "prune"]).optional(),
        }).default({}),
      },
    },
    async (req) => {
      admin(req);
      return state.svc.storage.planAndStore({ ...req.body, incomingPriority: req.body.incomingPriority });
    },
  );

  r.post(
    "/api/storage/eviction/run",
    {
      config: { auth: "session" },
      schema: { body: z.union([z.object({ planId: z.string().min(1).max(64) }), z.object({ maintenance: z.literal(true) })]) },
    },
    async (req) => {
      const svc = state.svc;
      const user = admin(req);
      if ("planId" in req.body) return svc.storage.publicResult(await svc.storage.runPlan(req.body.planId, user.userId));
      const m = await svc.storage.runMaintenanceEviction(user.userId);
      return { runs: m.runs.map((r) => svc.storage.publicResult(r)), notes: m.notes };
    },
  );

  r.get("/api/storage/eviction/runs", { config: { auth: "session" }, schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) } }, async (req) => ({
    items: state.svc.db.all<{ public_id: string; trigger: string; state: string; incoming_priority: number; bytes_needed: number; versions_planned: number; versions_evicted: number; versions_skipped: number; bytes_freed: number; blobs_deleted: number; error: string | null; started_at: number; finished_at: number | null }>(
      "SELECT * FROM eviction_runs ORDER BY id DESC LIMIT ?", [req.query.limit]).map((x) => ({
      id: x.public_id, trigger: x.trigger, state: x.state, incomingPriority: priorityToCode(x.incoming_priority as PriorityNumber), bytesNeeded: x.bytes_needed,
      versionsPlanned: x.versions_planned, versionsEvicted: x.versions_evicted, versionsSkipped: x.versions_skipped, bytesFreed: x.bytes_freed, blobsDeleted: x.blobs_deleted,
      ...(x.error ? { error: x.error } : {}), startedAt: new Date(x.started_at).toISOString(), ...(x.finished_at ? { finishedAt: new Date(x.finished_at).toISOString() } : {}),
    })),
  }));

  r.get("/api/storage/pages/:id", { config: { auth: "session" }, schema: { params: pageParam } }, async (req) => state.svc.storage.explainPage(req.params.id));

  r.put(
    "/api/storage/pages/:id/pin",
    { config: { auth: "session" }, schema: { params: pageParam, body: z.object({ priority: priorityIn.default(1), reason: z.string().max(300).optional() }).default({ priority: 1 }) } },
    async (req) => {
      const svc = state.svc;
      const user = admin(req);
      svc.storage.setPin(req.params.id, user.userId, req.body.priority, req.body.reason);
      svc.activity.write({ level: "info", area: "storage", message: `Kept a page at ${priorityToCode(req.body.priority)}`, details: { pageId: req.params.id }, userId: user.userId });
      return svc.storage.explainPage(req.params.id);
    },
  );

  r.delete("/api/storage/pages/:id/pin", { config: { auth: "session" }, schema: { params: pageParam } }, async (req) => {
    const svc = state.svc;
    const user = admin(req);
    svc.storage.removePin(req.params.id, user.userId);
    return svc.storage.explainPage(req.params.id);
  });

  r.get(
    "/api/storage/audit",
    {
      config: { auth: "session" },
      schema: { querystring: z.object({ pageId: z.string().optional(), kind: z.enum(["evicted", "deleted"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.coerce.number().int().optional() }) },
    },
    async (req) => {
      const svc = state.svc;
      let pageDbId: number | undefined;
      if (req.query.pageId) {
        const p = svc.db.get<{ id: number }>("SELECT id FROM pages WHERE public_id = ?", [req.query.pageId]);
        // A deleted page has no row any more; its audit rows keep the old internal id, found through them by public id is not possible, so say so.
        if (!p) return { items: [] };
        pageDbId = p.id;
      }
      return svc.storage.auditFor({ pageDbId, kind: req.query.kind, limit: req.query.limit, cursor: req.query.cursor });
    },
  );

  r.post(
    "/api/storage/maintenance/verify",
    { config: { auth: "session" }, schema: { body: z.object({ repair: z.boolean().default(false), checks: z.array(z.string().max(8)).max(14).optional() }).default({ repair: false }) } },
    async (req) => state.svc.storage.maintenance.verify({ repair: req.body.repair, checks: req.body.checks }),
  );
}

type Svc = Services;

/** The `StoragePolicy` object of the API. */
function policyOut(svc: Svc) {
  const st = svc.settings.internal("storage");
  return {
    permitImportantEviction: st.permitImportantEviction,
    permitAcknowledgedAt: st.permitAcknowledgedAt,
    throttleOpportunistic: st.throttleOpportunistic,
    pruneSurplusVersions: st.pruneSurplusVersions,
    orphanGraceSeconds: st.orphanGraceSeconds,
    autoEviction: st.autoEviction,
    maxEvictionBatchBytes: st.maxEvictionBatchBytes,
    forecastHorizonDays: st.forecastHorizonDays,
    scrubMegabytesPerRun: st.scrubMegabytesPerRun,
    protectedNeverEvicted: true as const,
    warnings: { permitImportantEviction: P2_PERMIT_WARNING },
    volumeThresholds: svc.volumes.list().map((v) => ({ volumeId: v.publicId, name: v.name, softPct: v.softThresholdPct, evictStartPct: v.evictStartPct, evictTargetPct: v.evictTargetPct })),
  };
}
