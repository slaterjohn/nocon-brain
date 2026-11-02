import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

const bool = z.preprocess((v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : v), z.boolean());
const idParam = z.object({ id: z.string().min(1).max(64) });
const paging = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().regex(/^\d+$/).optional() });

/** docs/api.md section 7 (sources). Bodies are validated by the service so every error carries field paths. */
export function sourceRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/sources",
    {
      config: { auth: "guest" },
      schema: { querystring: paging.extend({ type: z.string().max(40).optional(), enabled: bool.optional(), system: bool.optional() }) },
    },
    async (req) => state.svc.sources.list({ type: req.query.type, enabled: req.query.enabled, system: req.query.system, limit: req.query.limit, offset: req.query.cursor ? Number(req.query.cursor) : 0 }),
  );

  r.post("/api/sources", { config: { auth: "session" } }, async (req, reply) => {
    admin(req);
    const created = state.svc.sources.create(req.body);
    void reply.code(201);
    return created;
  });

  r.post("/api/sources/preview", { config: { auth: "session" } }, async (req) => {
    admin(req);
    return state.svc.sources.preview(req.body);
  });

  r.get("/api/sources/:id", { config: { auth: "guest" }, schema: { params: idParam } }, async (req) => state.svc.sources.get(req.params.id));

  r.patch("/api/sources/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.sources.update(req.params.id, req.body);
  });

  r.delete("/api/sources/:id", { config: { auth: "session" }, schema: { params: idParam, querystring: z.object({ deletePages: bool.default(false) }) } }, async (req) => {
    admin(req);
    return state.svc.sources.remove(req.params.id, { deletePages: req.query.deletePages });
  });

  r.post("/api/sources/:id/run", { config: { auth: "session" }, schema: { params: idParam } }, async (req, reply) => {
    admin(req);
    const out = await state.svc.sources.run(req.params.id, { requestedBy: "user" });
    void reply.code(202);
    return out;
  });

  r.post("/api/sources/:id/refresh", { config: { auth: "session" }, schema: { params: idParam } }, async (req, reply) => {
    admin(req);
    const out = await state.svc.sources.refresh(req.params.id, { requestedBy: "user" });
    void reply.code(202);
    return { downloadIds: out.downloadIds, pages: state.svc.refresh.pageCount(state.svc.sources.resolvePublicId(req.params.id)) };
  });

  r.post("/api/sources/:id/pause", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.sources.setPaused(req.params.id, true);
  });

  r.post("/api/sources/:id/resume", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.sources.setPaused(req.params.id, false);
  });

  r.get("/api/sources/:id/pages", { config: { auth: "guest" }, schema: { params: idParam, querystring: paging.extend({ cursor: z.string().max(500).optional() }) } }, async (req) => {
    // A knowledge-package source lists the package's entries by title; its cursor is the last title shown.
    if (state.svc.sources.rowByPublic(req.params.id).type === "knowledge_package") {
      return state.svc.sources.knowledgePages(req.params.id, { limit: req.query.limit, after: req.query.cursor });
    }
    if (req.query.cursor !== undefined && !/^\d+$/.test(req.query.cursor)) throw new AppError("bad_request", "That cursor is not valid.", { fields: [{ in: "query", path: "cursor", message: "Use the cursor from the previous page" }] });
    return state.svc.sources.pages(req.params.id, { limit: req.query.limit, offset: req.query.cursor ? Number(req.query.cursor) : 0 });
  });

  r.get("/api/sources/:id/stats", { config: { auth: "guest" }, schema: { params: idParam } }, async (req) => state.svc.sources.stats(req.params.id));
}
