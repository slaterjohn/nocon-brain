import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import { parseOrThrow, type ZodTypeProvider } from "../lib/zod.js";
import { scheduleBodySchema } from "../schedule/service.js";
import { statusToApi } from "../schedule/windows.js";

const idParam = z.object({ id: z.string().min(1).max(64) });

/** docs/api.md section 8 (schedules and global download windows). */
export function scheduleRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/schedules", { config: { auth: "session" }, schema: { querystring: z.object({ sourceId: z.string().max(64).optional() }) } }, async (req) => {
    const svc = state.svc;
    return { items: svc.schedules.list(req.query.sourceId ? { sourceId: svc.sources.resolvePublicId(req.query.sourceId) } : {}) };
  });

  r.post("/api/schedules", { config: { auth: "session" } }, async (req, reply) => {
    admin(req);
    const svc = state.svc;
    const body = parseOrThrow(scheduleBodySchema, req.body);
    const sourceRow = body.sourceId ? svc.sources.resolvePublicId(body.sourceId) : null;
    if (sourceRow === null) throw new AppError("bad_request", "Choose the source this schedule is for.", { fields: [{ in: "body", path: "sourceId", message: "Required" }] });
    const created = svc.schedules.create(sourceRow, req.body);
    void reply.code(201);
    return created;
  });

  r.get("/api/schedules/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => state.svc.schedules.get(req.params.id));

  r.patch("/api/schedules/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.schedules.update(req.params.id, req.body);
  });

  r.delete("/api/schedules/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req, reply) => {
    admin(req);
    state.svc.schedules.remove(req.params.id);
    return reply.code(204).send();
  });

  r.get("/api/downloads/windows", { config: { auth: "session" } }, async () => {
    const svc = state.svc;
    return { windows: svc.schedules.listGlobalWindows(), status: statusToApi(svc.scheduler.isOpen(null, "schedule")) };
  });

  r.put("/api/downloads/windows", { config: { auth: "session" } }, async (req) => {
    admin(req);
    const svc = state.svc;
    const windows = svc.schedules.replaceGlobalWindows(req.body);
    return { windows, status: statusToApi(svc.scheduler.isOpen(null, "schedule")) };
  });
}
