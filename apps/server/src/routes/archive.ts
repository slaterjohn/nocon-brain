import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import { captureEvent } from "../pipeline/progress.js";
import type { ZodTypeProvider } from "../lib/zod.js";

const bool = z.preprocess((v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : v), z.boolean());
const priority = z.union([z.enum(["P1", "P2", "P3", "P4"]).transform((p) => Number(p.slice(1))), z.number().int().min(1).max(4)]);

const PAGE_TYPES = ["html", "pdf", "markdown", "text", "rendered"] as const;

/** `2025-03-01` or a full ISO instant. A date alone for `to` includes that whole day (the result is the start of the next day). */
function instant(name: string, raw: string | undefined, endOfDay: boolean): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const t = Date.parse(dateOnly ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(t)) throw new AppError("bad_request", `Use a date such as 2025-03-01 for ${name}.`, { fields: [{ in: "query", path: name, message: "Use a date such as 2025-03-01" }] });
  return dateOnly && endOfDay ? t + 86_400_000 : t;
}

function csv<T extends string>(name: string, raw: string | undefined, allowed: readonly T[]): T[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(",").map((x) => x.trim()).filter(Boolean);
  const bad = items.find((x) => !(allowed as readonly string[]).includes(x));
  if (bad) throw new AppError("bad_request", `Use ${allowed.join(", ")} for ${name}.`, { fields: [{ in: "query", path: name, message: `"${bad}" is not one of ${allowed.join(", ")}` }] });
  return items as T[];
}

function forwardedHost(req: FastifyRequest, proxyVerified: (r: FastifyRequest) => boolean): string | undefined {
  if (!proxyVerified(req)) return undefined;
  const v = req.headers["x-forwarded-host"];
  return Array.isArray(v) ? v[0] : v;
}

/** docs/api.md section 4 (the parts of Phase 2: list, detail, delete, versions, find, capture, frame grants). */
export function archiveRoutes(app: FastifyInstance, state: ServerState, o: { proxyVerified: (r: FastifyRequest) => boolean }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/archive/pages",
    {
      config: { auth: "guest" },
      schema: {
        querystring: z.object({
          q: z.string().max(200).optional(),
          domain: z.string().max(200).optional(),
          availability: z.string().max(100).optional(),
          sourceId: z.string().min(1).max(64).optional(),
          collectionId: z.string().min(1).max(64).optional(),
          from: z.string().max(40).optional(),
          to: z.string().max(40).optional(),
          type: z.string().max(100).optional(),
          priority: z.string().max(20).optional(),
          minVersions: z.coerce.number().int().min(1).max(10_000).optional(),
          sort: z.enum(["captured", "title", "size", "site"]).default("captured"),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().regex(/^\d+$/).optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const availability = q.availability?.split(",").map((s) => s.trim()).filter((s) => ["archived", "partial", "evicted", "failed"].includes(s));
      const types = csv("type", q.type, PAGE_TYPES);
      const priorities = csv("priority", q.priority, ["P1", "P2", "P3", "P4"] as const)?.map((p) => Number(p.slice(1)));
      return state.svc.library.list({
        q: q.q, domain: q.domain, availability, sort: q.sort, limit: q.limit, offset: q.cursor ? Number(q.cursor) : 0,
        sourceId: q.sourceId, collectionId: q.collectionId, from: instant("from", q.from, false), to: instant("to", q.to, true), types, priorities, minVersions: q.minVersions,
      });
    },
  );

  r.get("/api/archive/pages/:id", { config: { auth: "guest" }, schema: { params: z.object({ id: z.string().max(64) }) } }, async (req) =>
    state.svc.library.detail(req.params.id),
  );

  r.delete(
    "/api/archive/pages/:id",
    {
      config: { auth: "session" },
      schema: {
        params: z.object({ id: z.string().max(64) }),
        querystring: z.object({ dryRun: bool.default(false), confirmProtected: bool.default(false), exclude: bool.default(true) }),
      },
    },
    async (req) => {
      const lib = state.svc.library;
      admin(req);
      if (req.query.dryRun) return lib.preview(req.params.id);
      return lib.deletePage(req.params.id, { confirmProtected: req.query.confirmProtected, exclude: req.query.exclude, userId: admin(req).userId });
    },
  );

  r.get("/api/archive/versions", { config: { auth: "guest" }, schema: { querystring: z.object({ pageId: z.string().min(1).max(64) }) } }, async (req) =>
    ({ items: state.svc.library.detail(req.query.pageId).versions }),
  );

  r.get("/api/archive/versions/:id", { config: { auth: "guest" }, schema: { params: z.object({ id: z.string().max(64) }) } }, async (req) => {
    const svc = state.svc;
    const v = svc.pipeline.getVersion(req.params.id);
    if (!v) throw new AppError("not_found", "That saved copy does not exist.");
    return { ...svc.browser.versionSummary(v), title: v.title, url: v.finalUrl, stages: v.stages, failureMessage: v.failureMessage };
  });

  r.get(
    "/api/archive/versions/:id/find",
    { config: { auth: "guest" }, schema: { params: z.object({ id: z.string().max(64) }), querystring: z.object({ q: z.string().max(400).default("") }) } },
    async (req) => state.svc.library.find(req.params.id, req.query.q),
  );

  r.post(
    "/api/archive/capture",
    {
      config: { auth: "session" },
      schema: {
        body: z.object({
          url: z.string().min(1).max(4096), sourceId: z.string().max(64).optional(), priority: priority.optional(),
          mode: z.literal("capture").optional(), queue: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const svc = state.svc;
      admin(req);
      const k = req.headers["idempotency-key"];
      const key = typeof k === "string" && k.length <= 200 ? `${req.url.split("?")[0]}:${k}` : undefined;
      const sourceId = req.body.sourceId ? svc.sources.resolvePublicId(req.body.sourceId) : undefined;
      const out = svc.browser.remember(key, () => svc.browser.save({ url: req.body.url, priority: req.body.priority, queue: req.body.queue, sourceId }));
      void reply.code(202);
      return out;
    },
  );

  r.get("/api/archive/captures/:id", { config: { auth: "session" }, schema: { params: z.object({ id: z.string().max(64) }) } }, async (req) => {
    const p = state.svc.pipeline.captureProgress(req.params.id);
    if (!p) throw new AppError("not_found", "That download no longer exists.");
    return p;
  });

  r.get("/api/archive/captures", { config: { auth: "session" }, schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }) } }, async (req) => {
    const svc = state.svc;
    const rows = svc.db.all<{ id: number }>("SELECT id FROM download_jobs WHERE kind = 'capture' ORDER BY id DESC LIMIT ?", [req.query.limit]);
    return { items: rows.flatMap((x) => { const e = captureEvent(svc.db, x.id); return e ? [e] : []; }) };
  });

  r.post(
    "/api/archive/frame-grants",
    {
      config: { auth: "session" },
      schema: {
        body: z.object({ pageId: z.string().max(64).optional(), versionId: z.string().max(64).optional(), zimId: z.string().max(64).optional(), zimPath: z.string().max(2000).optional(), mode: z.enum(["original", "reader"]).default("original") }),
      },
    },
    async (req) => {
      const user = admin(req);
      return state.svc.browser.frameGrant({ userId: user.userId, ...req.body, forwardedHost: forwardedHost(req, o.proxyVerified) });
    },
  );
}
