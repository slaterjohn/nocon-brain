import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parsePriority, type PriorityNumber } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

const idParam = z.object({ id: z.string().min(1).max(64) });
const list = (max: number) => z.string().max(max).transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));
const priorityIn = z.union([z.enum(["P1", "P2", "P3", "P4"]), z.number().int().min(1).max(4)], { error: "Use P1, P2, P3 or P4" }).transform((v) => parsePriority(v) as PriorityNumber);

const listQuery = z.object({
  state: list(100).pipe(z.array(z.enum(["queued", "running", "paused", "completed", "failed", "cancelled"], { error: "Use queued, running, paused, completed, failed or cancelled" }))).optional(),
  kind: list(200).pipe(z.array(z.enum(["capture", "explore", "mirror", "refresh", "wikipedia", "zim_import", "import", "discovery", "coverage"]))).optional(),
  priority: priorityIn.optional(),
  sourceId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d+$/).optional(),
});

const createBody = z.object({
  kind: z.string().min(1).max(40),
  url: z.string().trim().max(4096).optional(),
  sourceId: z.string().max(64).optional(),
  priority: priorityIn.optional(),
  config: z.unknown().optional(),
  asCollection: z.unknown().optional(),
});

const patchBody = z.object({
  priority: priorityIn.optional(),
  queueOrder: z.union([z.literal("top"), z.literal("bottom"), z.number().int().min(-1_000_000).max(1_000_000)]).optional(),
}).refine((v) => v.priority !== undefined || v.queueOrder !== undefined, { message: "Send a priority or a queue order" });

/** docs/api.md section 8 (the downloads queue). */
export function downloadRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/downloads", { config: { auth: "guest" }, schema: { querystring: listQuery } }, async (req) =>
    state.svc.downloads.list({
      state: req.query.state, kind: req.query.kind, priority: req.query.priority, sourceId: req.query.sourceId,
      limit: req.query.limit, cursor: req.query.cursor ? Number(req.query.cursor) : undefined,
    }),
  );

  r.get("/api/downloads/queue", { config: { auth: "guest" } }, async () => state.svc.downloads.queueSummary());

  r.post("/api/downloads", { config: { auth: "session" }, schema: { body: createBody, headers: z.object({ "idempotency-key": z.string().min(1).max(200).optional() }) } }, async (req, reply) => {
    admin(req);
    const out = await state.svc.downloads.create(req.body, req.headers["idempotency-key"]);
    void reply.code(out.replay ? 200 : 202);
    return out.download;
  });

  r.get("/api/downloads/:id", { config: { auth: "guest" }, schema: { params: idParam } }, async (req) => state.svc.downloads.get(req.params.id));

  r.get("/api/downloads/:id/log", {
    config: { auth: "session" },
    schema: {
      params: idParam,
      querystring: z.object({ level: list(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().regex(/^\d+$/).optional() }),
    },
  }, async (req) => state.svc.downloads.log(req.params.id, { level: req.query.level, limit: req.query.limit, cursor: req.query.cursor ? Number(req.query.cursor) : undefined }));

  for (const action of ["pause", "resume", "cancel", "retry"] as const) {
    r.post(`/api/downloads/:id/${action}`, { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
      admin(req);
      return state.svc.downloads[action](req.params.id);
    });
  }

  r.patch("/api/downloads/:id", { config: { auth: "session" }, schema: { params: idParam, body: patchBody } }, async (req) => {
    admin(req);
    return state.svc.downloads.setPriority(req.params.id, req.body);
  });
}
