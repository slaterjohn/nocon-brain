import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";

export function settingsRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/settings", { config: { auth: "guest" } }, async () => state.svc.settings.getAll());

  // Body is a map of group name to a partial group. The service validates each group and names the exact field.
  r.patch("/api/settings", { config: { auth: "session" }, schema: { body: z.looseObject({}) } }, async (req) => {
    const svc = state.svc;
    const user = admin(req);
    const { applied, disclosure } = svc.settings.patch(req.body, user.userId);
    svc.activity.write({ level: "info", area: "system", message: `Settings changed: ${applied.join(", ")}`, userId: user.userId });
    return { ...svc.settings.getAll(), ...(disclosure ? { disclosure } : {}) };
  });

  r.get("/api/settings/schema", { config: { auth: "session" } }, async () => state.svc.settings.jsonSchema());

  r.get("/api/settings/user", { config: { auth: "session" } }, async (req) => state.svc.settings.getUser(admin(req).userId));

  r.patch("/api/settings/user", { config: { auth: "session" }, schema: { body: z.looseObject({}) } }, async (req) =>
    state.svc.settings.patchUser(admin(req).userId, req.body),
  );
}
