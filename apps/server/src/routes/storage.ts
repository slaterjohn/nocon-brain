import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, isPublicId } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

const idParam = z.object({
  id: z.string().refine((v) => isPublicId(v, "vol"), "Not a volume id"),
});

export function storageRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/storage/volumes", { config: { auth: "session" } }, async () => {
    const svc = state.svc;
    const rows = await svc.volumes.refreshAll();
    return { items: rows.map((v) => svc.volumes.toDto(v)) };
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
      return { volume: svc.volumes.toDto(volume), warnings };
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
      ...svc.volumes.toDto(v),
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
      return svc.volumes.toDto(v);
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
}
