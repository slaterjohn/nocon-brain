import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parsePriority, type PriorityNumber } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

const idParam = z.object({ id: z.string().min(1).max(64) });
const list = (max: number) => z.string().max(max).transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));
const priorityIn = z.union([z.enum(["P1", "P2", "P3", "P4"]), z.number().int().min(1).max(4)], { error: "Use P1, P2, P3 or P4" }).transform((v) => parsePriority(v) as PriorityNumber);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const STATES = ["new", "approved", "queued", "archived", "dismissed", "expired"] as const;
const KINDS = ["link", "search_result", "saved_search", "visit", "bookmark", "missing_link", "manual"] as const;

const listQuery = z.object({
  state: list(100).pipe(z.array(z.enum(STATES, { error: "Use new, approved, queued, archived, dismissed or expired" }))).optional(),
  sourceId: z.string().max(64).optional(),
  minScore: z.coerce.number().optional(),
  maxScore: z.coerce.number().optional(),
  provenance: list(200).pipe(z.array(z.enum(KINDS, { error: "Use link, search_result, saved_search, visit, bookmark, missing_link or manual" }))).optional(),
  q: z.string().trim().max(200).optional(),
  host: z.string().trim().max(255).optional(),
  sort: z.enum(["score", "-score", "recent", "oldest", "cost", "depth"]).default("score"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d+$/).optional(),
  includeHidden: bool.optional(),
});

const decideBody = z.object({ sourceId: z.string().max(64).optional(), collectionId: z.string().max(64).optional() }).default({});
const queueBody = z.object({ priority: priorityIn.optional(), sourceId: z.string().max(64).optional(), collectionId: z.string().max(64).optional() }).default({});
const bulkBody = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
  action: z.enum(["approve", "dismiss", "queue"], { error: "Use approve, dismiss or queue" }),
  priority: priorityIn.optional(), sourceId: z.string().max(64).optional(), collectionId: z.string().max(64).optional(),
});
const ledgerQuery = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  lane: z.enum(["active", "background", "auto_cache"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d+$/).optional(),
});

/** docs/api.md "Discovery (Phase 7, as built)". */
export function discoveryRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/discovery", { config: { auth: "session" } }, async () => state.svc.discovery.overview());

  r.get("/api/discovery/candidates", { config: { auth: "session" }, schema: { querystring: listQuery } }, async (req) =>
    state.svc.discovery.list({ ...req.query, cursor: req.query.cursor ? Number(req.query.cursor) : undefined }),
  );

  r.post("/api/discovery/candidates/bulk", { config: { auth: "session" }, schema: { body: bulkBody } }, async (req) => {
    admin(req);
    return state.svc.discovery.bulk(req.body);
  });

  r.get("/api/discovery/candidates/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => state.svc.discovery.get(req.params.id));
  r.get("/api/discovery/candidates/:id/explain", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => state.svc.discovery.explain(req.params.id));

  r.post("/api/discovery/candidates/:id/approve", { config: { auth: "session" }, schema: { params: idParam, body: decideBody } }, async (req) => {
    admin(req);
    return state.svc.discovery.approve(req.params.id, req.body);
  });
  r.post("/api/discovery/candidates/:id/dismiss", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => {
    admin(req);
    return state.svc.discovery.dismiss(req.params.id);
  });
  r.post("/api/discovery/candidates/:id/queue", { config: { auth: "session" }, schema: { params: idParam, body: queueBody } }, async (req, reply) => {
    admin(req);
    const out = state.svc.discovery.queue(req.params.id, req.body);
    void reply.code(202);
    return out;
  });

  r.get("/api/discovery/settings", { config: { auth: "session" } }, async () => state.svc.discovery.settingsView());
  r.put("/api/discovery/settings", { config: { auth: "session" } }, async (req) => state.svc.discovery.putSettings(req.body, admin(req).userId));

  r.post("/api/discovery/pause", { config: { auth: "session" } }, async (req) => {
    admin(req);
    const out = state.svc.discovery.runner.pause("user");
    return { paused: true, ...out };
  });
  r.post("/api/discovery/resume", { config: { auth: "session" } }, async (req) => {
    admin(req);
    state.svc.discovery.runner.resume();
    return { paused: false };
  });

  r.get("/api/discovery/budget", { config: { auth: "session" } }, async () => state.svc.discovery.budget());
  r.get("/api/discovery/ledger", { config: { auth: "session" }, schema: { querystring: ledgerQuery } }, async (req) =>
    state.svc.discovery.ledgerList({ ...req.query, cursor: req.query.cursor ? Number(req.query.cursor) : undefined }),
  );
  r.get("/api/discovery/runner", { config: { auth: "session" } }, async () => state.svc.discovery.runnerStatus());
  r.post("/api/discovery/run", { config: { auth: "session" } }, async (req) => {
    admin(req);
    return state.svc.discovery.runner.runPass("manual");
  });
}
