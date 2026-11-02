import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import { formatSse } from "../services/events.js";
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
export function searchRoutes(app: FastifyInstance, state: ServerState, o: { sseHeartbeatMs: number } = { sseHeartbeatMs: 15_000 }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const userOf = (req: { principal?: { kind: string; userId?: number } }): number | undefined => (req.principal?.kind === "admin" ? req.principal.userId : undefined);
  const readerId = (req: { principal?: { kind: string; userId?: number } }): number | null => userOf(req) ?? state.svc.auth.firstAdminId() ?? null;
  const online = () => {
    const x = state.svc.search.online;
    if (!x) throw new AppError("not_implemented", "Combined search is not available.");
    return x;
  };
  const svc = () => state.svc;

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

  // ---- combined search (docs/api.md section 6.2) ----
  r.get("/api/search/providers", { config: { auth: "session" } }, async (req) => {
    admin(req);
    return { items: svc().providers.list(), online: svc().providers.onlineInfo() };
  });
  r.post("/api/search/providers", { config: { auth: "session" } }, async (req, reply) => {
    const out = svc().providers.create(req.body, admin(req).userId);
    void reply.code(201);
    return out;
  });
  r.get("/api/search/providers/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => { admin(req); return svc().providers.get(req.params.id); });
  r.patch("/api/search/providers/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => svc().providers.update(req.params.id, req.body, admin(req).userId));
  r.delete("/api/search/providers/:id", { config: { auth: "session" }, schema: { params: idParam } }, async (req, reply) => {
    svc().providers.remove(req.params.id, admin(req).userId);
    return reply.code(204).send();
  });
  r.post("/api/search/providers/:id/test", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => { admin(req); return svc().providers.test(req.params.id); });
  r.get("/api/search/providers/:id/usage", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => { admin(req); return svc().providers.usageDetail(req.params.id); });

  r.post("/api/search/coverage/plan", { config: { auth: "session" } }, async (req) => { admin(req); return svc().coverage.plan(req.body); });
  r.post("/api/search/coverage/queue", { config: { auth: "session" } }, async (req, reply) => {
    admin(req);
    const out = svc().coverage.queue(req.body);
    void reply.code(202);
    return out;
  });

  r.post("/api/search/saved/:id/source", { config: { auth: "session" }, schema: { params: idParam } }, async (req, reply) => {
    const out = svc().savedSources.create(admin(req).userId, req.params.id, req.body);
    void reply.code(201);
    return out;
  });
  r.get("/api/search/saved/:id/candidates", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => svc().savedSources.candidates(admin(req).userId, req.params.id));
  r.post("/api/search/saved/:id/candidates/approve", { config: { auth: "session" }, schema: { params: idParam } }, async (req, reply) => {
    const out = svc().savedSources.approve(admin(req).userId, req.params.id, req.body);
    void reply.code(202);
    return out;
  });
  r.post("/api/search/saved/:id/candidates/dismiss", { config: { auth: "session" }, schema: { params: idParam } }, async (req) => svc().savedSources.dismiss(admin(req).userId, req.params.id, req.body));

  r.post("/api/search/:id/more", { config: { auth: "session" }, schema: { params: idParam } }, async (req, reply) => {
    admin(req);
    const out = online().more(req.params.id, req.body);
    void reply.code(202);
    return out;
  });
  r.post("/api/search/:id/results/:key/save", {
    config: { auth: "session" }, schema: { params: z.object({ id: z.string().min(1).max(64), key: z.string().min(1).max(64) }) },
  }, async (req, reply) => {
    admin(req);
    const out = online().save(req.params.id, req.params.key, req.body);
    void reply.code(202);
    return out;
  });

  r.get("/api/search/:id/events", {
    config: { auth: "guest" },
    schema: { params: idParam, querystring: z.object({ after: z.coerce.number().int().min(0).optional() }) },
  }, async (req, reply) => {
    const on = online();
    const s = on.get(req.params.id);
    if (!s) throw new AppError("not_found", "That search has expired. Run it again.");
    const hdr = req.headers["last-event-id"];
    const fromHeader = Number(Array.isArray(hdr) ? hdr[0] : hdr);
    const last = Number.isFinite(fromHeader) && (Array.isArray(hdr) ? hdr[0] : hdr) !== undefined && (Array.isArray(hdr) ? hdr[0] : hdr) !== "" ? fromHeader : req.query.after;
    const missed = on.eventsAfter(s, last ?? 0);
    // A client that has already seen the final `done` is told to stop reconnecting.
    if (last !== undefined && s.done && missed.length === 0) return reply.code(204).send();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no",
      "x-request-id": req.id, "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
    });
    res.write("retry: 3000\n\n");
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    let beat: NodeJS.Timeout | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      if (beat) clearInterval(beat);
      unsubscribe?.();
      state.streams.delete(handle);
      if (!res.writableEnded) res.end();
    };
    const handle = { end: finish };
    state.streams.add(handle);
    res.on("close", finish);
    req.raw.on("close", finish);
    const write = (e: { type: string; seq: number }) => {
      if (closed || res.writableEnded) return;
      res.write(formatSse({ id: e.seq, type: e.type, data: e }));
      if (e.type === "done") setImmediate(finish);
    };
    for (const e of missed) write(e);
    if (closed) return;
    if (s.done) { finish(); return; }
    unsubscribe = on.subscribe(s, write);
    beat = setInterval(() => { if (!res.writableEnded) res.write(": heartbeat\n\n"); }, o.sseHeartbeatMs);
    beat.unref();
  });

  r.get("/api/search/:id", {
    config: { auth: "guest" },
    schema: { params: idParam, querystring: z.object({ after: z.coerce.number().int().min(0).optional(), order: z.enum(["fused"]).optional() }) },
  }, async (req) => {
    if (req.query.after !== undefined) return online().poll(req.params.id, req.query.after);
    return state.svc.search.snapshot(req.params.id, { order: req.query.order });
  });

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
