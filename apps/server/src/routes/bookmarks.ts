import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

const isoDate = z.iso.datetime({ offset: true }).optional();

/** docs/api.md section 14. */
export function bookmarkRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/bookmarks",
    { config: { auth: "guest" }, schema: { querystring: z.object({ q: z.string().max(200).optional(), url: z.string().max(4096).optional(), collectionId: z.string().optional() }) } },
    async (req) => {
      // A guest on the trusted LAN sees the first administrator's bookmarks (read-only).
      const userId = req.principal?.kind === "admin" ? req.principal.userId : state.svc.auth.firstAdminId();
      return { items: userId == null ? [] : state.svc.bookmarks.list(userId, { q: req.query.q, url: req.query.url }) };
    },
  );

  r.post(
    "/api/bookmarks",
    {
      config: { auth: "session" },
      schema: {
        body: z.object({
          url: z.string().min(1).max(4096).optional(), title: z.string().max(300).optional(), collectionId: z.string().optional(), versionId: z.string().max(64).optional(),
          /** An entry of a knowledge package (`zim_` id and path), for entries that have no web address of their own. */
          zimId: z.string().max(64).optional(), zimPath: z.string().min(1).max(2000).optional(),
        }).refine((b) => !!b.url || (!!b.zimId && !!b.zimPath), { message: "Give an address, or a package and an entry", path: ["url"] }),
      },
    },
    async (req, reply) => {
      const user = admin(req);
      const { bookmark, created } = await state.svc.bookmarks.create(user.userId, req.body);
      void reply.code(created ? 201 : 200);
      return bookmark;
    },
  );

  r.patch(
    "/api/bookmarks/:id",
    { config: { auth: "session" }, schema: { params: z.object({ id: z.string().max(64) }), body: z.object({ title: z.string().max(300).optional() }) } },
    async (req) => state.svc.bookmarks.update(admin(req).userId, req.params.id, req.body),
  );

  r.delete("/api/bookmarks/:id", { config: { auth: "session" }, schema: { params: z.object({ id: z.string().max(64) }) } }, async (req, reply) => {
    state.svc.bookmarks.remove(admin(req).userId, req.params.id);
    return reply.code(204).send();
  });

  r.get(
    "/api/history",
    { config: { auth: "session" }, schema: { querystring: z.object({ q: z.string().max(200).optional(), from: isoDate, to: isoDate, limit: z.coerce.number().int().min(1).max(500).default(200) }) } },
    async (req) => {
      const svc = state.svc;
      const user = admin(req);
      const enabled = svc.history.enabled;
      const items = svc.history.list(user.userId, {
        q: req.query.q, limit: req.query.limit,
        from: req.query.from ? Date.parse(req.query.from) : undefined, to: req.query.to ? Date.parse(req.query.to) : undefined,
      });
      return { enabled, items };
    },
  );

  r.delete("/api/history", { config: { auth: "session" }, schema: { querystring: z.object({ before: isoDate }) } }, async (req) => {
    const user = admin(req);
    const deleted = state.svc.history.clear(user.userId, req.query.before ? Date.parse(req.query.before) : undefined);
    return { deleted };
  });

  r.delete("/api/history/:id", { config: { auth: "session" }, schema: { params: z.object({ id: z.string().max(64) }) } }, async (req, reply) => {
    state.svc.history.remove(admin(req).userId, req.params.id);
    return reply.code(204).send();
  });
}
