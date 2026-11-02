import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

const bool = z.preprocess((v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : v), z.boolean());
const idParam = z.object({ id: z.string().min(1).max(64) });

/** docs/api.md "Knowledge packages (Phase 8, as built)". Bodies are validated by the service so errors carry field paths. */
export function zimRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/zim/packages",
    { config: { auth: "guest" }, schema: { querystring: z.object({ language: z.string().max(12).optional(), enabledForSearch: bool.optional(), state: z.string().max(20).optional() }) } },
    async (req) => state.svc.zim.list(req.query),
  );

  r.post("/api/zim/packages/import", { config: { auth: "session" } }, async (req, reply) => {
    admin(req);
    const out = await state.svc.zim.register(req.body);
    void reply.code(out.status);
    return out.package;
  });

  r.get("/api/zim/status", { config: { auth: "guest" } }, async () => {
    const { zim, zimSource } = state.svc;
    const rows = zim.rows();
    return {
      workers: zimSource.workerCount(), restarts: zimSource.stats.restarts, crashes: zimSource.stats.crashes, hangs: zimSource.stats.hangs,
      packages: rows.length, ready: rows.filter((x) => x.state === "ready").length, degraded: rows.filter((x) => x.state === "degraded").length, missing: rows.filter((x) => x.state === "missing").length,
      usage: zim.usage(),
    };
  });

  r.get("/api/zim/packages/:id", { config: { auth: "guest" }, schema: { params: idParam } }, async (req) => state.svc.zim.get(req.params.id));

  r.patch("/api/zim/packages/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.zim.patch(req.params.id, req.body);
  });

  r.get("/api/zim/packages/:id/references", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.zim.removalPlan(req.params.id);
  });

  r.delete(
    "/api/zim/packages/:id",
    { config: { auth: "session" }, schema: { params: idParam, querystring: z.object({ confirm: bool.default(false), dryRun: bool.default(false) }) } },
    async (req) => {
      admin(req);
      return state.svc.zim.remove(req.params.id, req.query);
    },
  );

  r.post("/api/zim/packages/:id/verify", { config: { auth: "session" }, schema: { params: idParam, body: z.object({ deep: z.boolean().default(false) }).default({ deep: false }) } }, async (req) => {
    admin(req);
    return state.svc.zim.verify(req.params.id, req.body.deep);
  });

  r.get(
    "/api/zim/packages/:id/entries",
    { config: { auth: "guest" }, schema: { params: idParam, querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(500).optional() }) } },
    async (req) => {
      const { zim, zimSource } = state.svc;
      const row = zim.rowByPublic(req.params.id);
      if (!(await zim.ensureOpen(row))) throw new AppError("unavailable", "This knowledge package is not available right now.", { zimCode: row.state });
      const out = await zimSource.browse(row.public_id, { after: req.query.cursor, limit: req.query.limit });
      return { items: out.items.map((e) => ({ zimId: row.public_id, path: e.path, title: e.title })), total: row.article_count, ...(out.next ? { nextCursor: out.next } : {}) };
    },
  );

  r.get(
    "/api/zim/packages/:id/suggest",
    { config: { auth: "guest" }, schema: { params: idParam, querystring: z.object({ q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(20).default(8) }) } },
    async (req) => {
      const { zim, zimSource, settings } = state.svc;
      const row = zim.rowByPublic(req.params.id);
      if (!(await zim.ensureOpen(row))) throw new AppError("unavailable", "This knowledge package is not available right now.", { zimCode: row.state });
      const budget = (settings.internal("search") as { zimSearchBudgetMs: number }).zimSearchBudgetMs;
      const out = await zimSource.suggest(row.public_id, req.query.q, { limit: req.query.limit, budgetMs: budget });
      return { items: out.hits.map((h) => ({ zimId: row.public_id, path: h.path, title: h.title })), partial: out.partial };
    },
  );

  r.get(
    "/api/zim/packages/:id/search",
    { config: { auth: "guest" }, schema: { params: idParam, querystring: z.object({ q: z.string().min(1).max(500), limit: z.coerce.number().int().min(1).max(50).default(10) }) } },
    async (req) => {
      const out = await state.svc.zimSearch.search(
        { query: req.query.q, packages: [req.params.id], budgetMs: (state.svc.settings.internal("search") as { zimSearchBudgetMs: number }).zimSearchBudgetMs, maxPackages: 1, hitsPerPackage: req.query.limit },
        "federated",
      );
      const g = out.groups[0];
      if (!g) throw new AppError("conflict", "This package is switched off for search or is not available.", { skipped: out.skipped });
      return { zimId: g.zimId, mode: g.mode, state: g.state, ...(g.message ? { message: g.message } : {}), estimatedMatches: g.estimatedMatches, tookMs: g.tookMs, items: g.hits };
    },
  );

  r.get(
    "/api/zim/packages/:id/entry",
    { config: { auth: "guest" }, schema: { params: idParam, querystring: z.object({ path: z.string().min(1).max(2000) }) } },
    async (req) => {
      const { zim, zimSource } = state.svc;
      const row = zim.rowByPublic(req.params.id);
      if (!(await zim.ensureOpen(row))) throw new AppError("unavailable", "This knowledge package is not available right now.", { zimCode: row.state });
      const e = await zimSource.readEntry(row.public_id, req.query.path, { follow: false });
      if (e.kind === "missing") return { zimId: row.public_id, path: req.query.path, exists: false };
      if (e.kind === "redirect") return { zimId: row.public_id, path: e.path, exists: true, redirectTo: e.target };
      return { zimId: row.public_id, path: e.path, exists: true, title: e.title, mimeType: e.mimeType, sizeBytes: e.size };
    },
  );

  r.get("/api/zim/packages/:id/illustration", { config: { auth: "guest" }, schema: { params: idParam } }, async (req, reply) => {
    const { zim, zimSource } = state.svc;
    const row = zim.rowByPublic(req.params.id);
    if (row.has_illustration !== 1 || !(await zim.ensureOpen(row))) throw new AppError("not_found", "This package has no icon.");
    const img = await zimSource.illustration(row.public_id);
    if (!img || !/^image\/(png|jpeg|webp|gif)$/.test(img.mimeType)) throw new AppError("not_found", "This package has no icon.");
    void reply.header("content-type", img.mimeType).header("cache-control", "private, max-age=86400").header("x-content-type-options", "nosniff");
    return Buffer.from(img.data);
  });
}
