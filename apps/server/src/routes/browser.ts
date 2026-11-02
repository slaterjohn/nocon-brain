import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";
import type { FastifyRequest } from "fastify";

const priority = z.union([z.enum(["P1", "P2", "P3", "P4"]).transform((p) => Number(p.slice(1))), z.number().int().min(1).max(4)]);

function forwardedHost(req: FastifyRequest, proxyVerified: (r: FastifyRequest) => boolean): string | undefined {
  if (!proxyVerified(req)) return undefined;
  const v = req.headers["x-forwarded-host"];
  return Array.isArray(v) ? v[0] : v;
}

function idempotencyKey(req: FastifyRequest): string | undefined {
  const v = req.headers["idempotency-key"];
  const k = Array.isArray(v) ? v[0] : v;
  return k && k.length <= 200 ? `${req.url.split("?")[0]}:${k}` : undefined;
}

/** docs/api.md section 3 (browser) and the capture convenience of section 4. */
export function browserRoutes(app: FastifyInstance, state: ServerState, o: { proxyVerified: (r: FastifyRequest) => boolean }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/browser/resolve",
    {
      config: { auth: "session" },
      schema: {
        body: z.object({
          input: z.string().min(1, "Enter a web address or some search terms").max(4096),
          tabId: z.string().max(64).optional(),
          prefer: z.enum(["archive", "live", "reader"]).optional(),
          versionId: z.string().max(64).optional(),
          frame: z.object({ appOrigin: z.string().max(300) }).optional(),
        }),
      },
    },
    async (req) => {
      const svc = state.svc;
      const user = admin(req);
      const res = svc.browser.resolve({
        userId: user.userId, input: req.body.input, prefer: req.body.prefer, versionId: req.body.versionId,
        forwardedHost: forwardedHost(req, o.proxyVerified),
      });
      const rs = res.resolution;
      // Archived visits are recorded when the listener serves the page (frame-state); the rest are recorded here.
      if (rs.kind === "live") {
        svc.history.record(user.userId, { url: rs.url, servedFrom: "live" });
        // The Human opened this page live: the auto-cache (off by default) may keep it. Only this page, nothing it links to.
        svc.discovery.onOpened(rs.url);
      }
      else if (rs.kind === "offline") svc.history.record(user.userId, { url: rs.url, servedFrom: "offline" });
      return res;
    },
  );

  r.get("/api/browser/frame-state", { config: { auth: "guest" }, schema: { querystring: z.object({ frameId: z.string().min(1).max(64) }) } }, async (req) => {
    const user = req.principal?.kind === "admin" ? req.principal.userId : 0;
    const fs = state.svc.browser.frameState(user, req.query.frameId);
    if (!fs) throw new AppError("not_found", "That frame has not shown a page yet.");
    return fs;
  });

  r.post(
    "/api/browser/link-states",
    { config: { auth: "session" }, schema: { body: z.object({ urls: z.array(z.string().max(4096)).max(200) }) } },
    async (req) => ({ items: state.svc.browser.linkStates(req.body.urls) }),
  );

  r.post(
    "/api/browser/live-check",
    { config: { auth: "session" }, schema: { body: z.object({ url: z.string().min(1).max(4096) }) } },
    async (req) => state.svc.browser.liveCheck(req.body.url),
  );

  const saveBody = z.object({ url: z.string().min(1).max(4096), priority: priority.optional(), queue: z.boolean().optional() });
  r.post("/api/browser/save", { config: { auth: "session" }, schema: { body: saveBody } }, async (req, reply) => {
    const svc = state.svc;
    admin(req);
    const out = svc.browser.remember(idempotencyKey(req), () => svc.browser.save({ url: req.body.url, priority: req.body.priority, queue: req.body.queue }));
    void reply.code(202);
    return out;
  });

  r.get("/api/browser/offline-page", { config: { auth: "session" }, schema: { querystring: z.object({ url: z.string().min(1).max(4096) }) } }, async (req) =>
    state.svc.browser.offlinePage(req.query.url),
  );
}
