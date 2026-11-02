import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** A trusted-LAN guest may POST here (searching changes nothing). */
    guestPost?: boolean;
  }
}

const idParam = z.object({ id: z.string().min(1).max(64) });
const bool = z.preprocess((v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : v), z.boolean());

/** docs/api.md sections 6 and 6.1 (local search) and 11 (index). */
export function searchRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const userOf = (req: { principal?: { kind: string; userId?: number } }): number | undefined => (req.principal?.kind === "admin" ? req.principal.userId : undefined);
  const readerId = (req: { principal?: { kind: string; userId?: number } }): number | null => userOf(req) ?? state.svc.auth.firstAdminId() ?? null;
  const later = (what: string) => async () => { throw new AppError("not_implemented", `${what} arrives with combined search (Phase 5).`); };

  r.post("/api/search", { config: { auth: "guest", guestPost: true } }, async (req) => state.svc.search.search(req.body, { userId: userOf(req) }));

  r.get("/api/search/suggestions", {
    config: { auth: "guest" },
    schema: { querystring: z.object({ q: z.string().max(500).default(""), limit: z.coerce.number().int().min(1).max(20).default(8) }) },
  }, async (req) => state.svc.search.suggestions(req.query.q, req.query.limit, userOf(req)));

  r.get("/api/search/favicon/:id", { config: { auth: "guest" }, schema: { params: idParam } }, async (req, reply) => {
    const f = state.svc.search.faviconBlob(req.params.id);
    if (!f) throw new AppError("not_found", "No icon was archived for that page.");
    const { data } = await state.svc.blobs.read(f.sha256);
    void reply.header("content-type", f.mime).header("cache-control", "private, max-age=86400");
    return reply.send(data);
  });

  r.get("/api/search/saved", { config: { auth: "guest" } }, async (req) => state.svc.search.listSaved(readerId(req)));
  r.post("/api/search/saved", { config: { auth: "session" } }, async (req, reply) => {
    const out = state.svc.search.createSaved(admin(req).userId, req.body);
    void reply.code(201);
    return out;
  });
  r.get("/api/search/saved/:id", { config: { auth: "guest" }, schema: { params: idParam } }, async (req) => {
    const uid = readerId(req);
    if (uid === null) throw new AppError("not_found", "That saved search does not exist.");
    return state.svc.search.getSaved(uid, req.params.id);
  });
  r.patch("/api/search/saved/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => state.svc.search.patchSaved(admin(req).userId, req.params.id, req.body));
  r.delete("/api/search/saved/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req, reply) => {
    state.svc.search.deleteSaved(admin(req).userId, req.params.id);
    return reply.code(204).send();
  });
  r.post("/api/search/saved/:id/run", {
    config: { auth: "session" },
    schema: { params: idParam, body: z.object({ page: z.number().int().min(1).max(1000).optional(), pageSize: z.number().int().min(1).max(50).optional() }).default({}) },
  }, async (req) => state.svc.search.runSaved(admin(req).userId, req.params.id, req.body));

  r.get("/api/search/history", {
    config: { auth: "guest" },
    schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.coerce.number().int().min(1).optional() }) },
  }, async (req) => {
    // A guest never sees history.
    return state.svc.search.listHistory(userOf(req) ?? null, req.query.limit, req.query.cursor);
  });
  r.delete("/api/search/history", { config: { auth: "session" } }, async (req) => state.svc.search.clearHistory(admin(req).userId));
  r.delete("/api/search/history/:id", { config: { auth: "session" }, schema: { params: z.object({ id: z.coerce.number().int().min(1) }) } }, async (req, reply) => {
    state.svc.search.deleteHistory(admin(req).userId, req.params.id);
    return reply.code(204).send();
  });

  // Phase 5 routes: documented, answered with 501 until combined search exists.
  r.get("/api/search/:id/events", { config: { auth: "guest" }, schema: { params: idParam } }, later("Streaming online results"));
  r.post("/api/search/:id/more", { config: { auth: "session" }, schema: { params: idParam } }, later("Loading more from the web"));
  r.post("/api/search/coverage/plan", { config: { auth: "session" } }, later("Coverage planning"));
  r.post("/api/search/coverage/queue", { config: { auth: "session" } }, later("Coverage queueing"));
  r.get("/api/search/providers", { config: { auth: "session" } }, later("Search providers"));
  r.post("/api/search/providers", { config: { auth: "session" } }, later("Search providers"));
  r.get("/api/search/:id", { config: { auth: "guest" }, schema: { params: idParam } }, async (req) => state.svc.search.snapshot(req.params.id));

  // ---- index ----
  r.get("/api/index/status", { config: { auth: "guest" } }, async () => state.svc.search.status());
  r.post("/api/index/rebuild", { config: { auth: "session" } }, async (req, reply) => {
    admin(req);
    const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === "string" ? String((req.body as { reason: string }).reason).slice(0, 200) : "requested";
    const out = await state.svc.search.startRebuild(reason, { fresh: true });
    void reply.code(202);
    return out;
  });
  r.post("/api/index/optimize", { config: { auth: "session" } }, async (req) => { admin(req); return state.svc.search.optimize(); });
  r.post("/api/index/check", { config: { auth: "session" }, schema: { querystring: z.object({ repair: bool.default(false) }) } }, async (req) => {
    admin(req);
    return state.svc.search.check(req.query.repair);
  });
  r.get("/api/index/jobs", { config: { auth: "session" } }, async () => state.svc.search.jobs());
  r.get("/api/index/synonyms", { config: { auth: "session" } }, async () => state.svc.search.getSynonyms());
  r.put("/api/index/synonyms", { config: { auth: "session" } }, async (req) => { admin(req); return state.svc.search.putSynonyms(req.body); });
  r.get("/api/index/ranking", { config: { auth: "session" } }, async () => state.svc.search.getRanking());
  r.put("/api/index/ranking", { config: { auth: "session" } }, async (req) => { admin(req); return state.svc.search.putRanking(req.body); });
}
