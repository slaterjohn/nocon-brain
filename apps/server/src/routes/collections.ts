import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";
import { COLLECTION_ICONS } from "../collections/icons.js";

const bool = z.preprocess((v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : v), z.boolean());
const idParam = z.object({ id: z.string().min(1).max(64) });

/** docs/api.md section 7 (collections). */
export function collectionRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/collections", { config: { auth: "guest" }, schema: { querystring: z.object({ tree: bool.default(false) }) } }, async (req) => ({
    items: state.svc.collections.list({ tree: req.query.tree }),
  }));

  r.get("/api/collections/icons", { config: { auth: "guest" } }, async () => ({ items: COLLECTION_ICONS }));

  r.post("/api/collections", { config: { auth: "session" } }, async (req, reply) => {
    admin(req);
    const c = state.svc.collections.create(req.body);
    void reply.code(201);
    return c;
  });

  r.get("/api/collections/:id", { config: { auth: "guest" }, schema: { params: idParam } }, async (req) => state.svc.collections.get(req.params.id));

  r.patch("/api/collections/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.collections.update(req.params.id, req.body);
  });

  r.delete("/api/collections/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.collections.remove(req.params.id);
  });

  r.get(
    "/api/collections/:id/items",
    {
      config: { auth: "guest" },
      schema: { params: idParam, querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().regex(/^\d+$/).optional(), recursive: bool.default(false) }) },
    },
    async (req) => state.svc.collections.listItems(req.params.id, { limit: req.query.limit, offset: req.query.cursor ? Number(req.query.cursor) : 0, recursive: req.query.recursive }),
  );

  r.post("/api/collections/:id/items", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.collections.changeItems(req.params.id, req.body);
  });

  r.post("/api/collections/:id/rebuild", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.collections.rebuild(req.params.id);
  });
}
