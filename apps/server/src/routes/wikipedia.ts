import type { FastifyInstance } from "fastify";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

/** docs/api.md section 15.2. Bodies are validated by the service so errors carry field paths. */
export function wikipediaRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/api/wikipedia/preview", { config: { auth: "session" } }, async (req) => {
    admin(req);
    return state.svc.wikipedia.preview(req.body);
  });

  r.post("/api/wikipedia/crawl", { config: { auth: "session" } }, async (req, reply) => {
    admin(req);
    const out = await state.svc.wikipedia.startCrawl(req.body);
    void reply.code(202);
    return out;
  });

  r.get("/api/wikipedia/status", { config: { auth: "session" } }, async (req) => {
    admin(req);
    return state.svc.wikipedia.status();
  });

  /** "Try again now": closes the circuit breaker and forgets any wait. */
  r.post("/api/wikipedia/reset", { config: { auth: "session" } }, async (req) => {
    admin(req);
    state.svc.wikipedia.client.reset();
    return state.svc.wikipedia.status();
  });
}
