import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@ncb/shared";
import type { ServerState, Services } from "../context.js";
import { clientIp } from "../lib/clientip.js";
import { admin, clearSessionCookie, setSessionCookie } from "../lib/http.js";
import { RequestValidationError, type ZodTypeProvider } from "../lib/zod.js";
import { RESOURCE_PRESETS } from "../limits/presets.js";

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Use at least 3 characters")
  .max(64, "Use at most 64 characters")
  .regex(/^[A-Za-z0-9_.@-]+$/, "Use letters, numbers and . _ @ - only");
const passwordSchema = z.string().min(10, "Use at least 10 characters").max(256, "Use at most 256 characters");

const PROFILE_PRESETS = RESOURCE_PRESETS;

function meta(svc: Services, key: string): string | undefined {
  return svc.db.get<{ value: string | null }>("SELECT value FROM app_meta WHERE key = ?", [key])?.value ?? undefined;
}
function setMeta(svc: Services, key: string, value: string): void {
  svc.db.run("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}
function assertSetupOpen(svc: Services): void {
  if (meta(svc, "setup.complete") === "1") throw new AppError("conflict", "Setup is already complete. Use Settings to change things now.");
}

export function setupRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/setup/status", { config: { auth: "public" } }, async () => {
    const svc = state.svc;
    return {
      adminExists: svc.auth.hasAdmin(),
      storageConfigured: svc.volumes.list().length > 0,
      profile: meta(svc, "setup.profile") ?? null,
      firstSourceCreated: meta(svc, "setup.first_source") !== undefined,
      complete: meta(svc, "setup.complete") === "1",
    };
  });

  r.post(
    "/api/setup/admin",
    { config: { auth: "public" }, schema: { body: z.object({ username: usernameSchema, password: passwordSchema }) } },
    async (req, reply) => {
      const svc = state.svc;
      const user = await svc.auth.createAdmin(req.body.username, req.body.password);
      const { token } = svc.auth.createSession(user.id, clientIp(req), req.headers["user-agent"] ?? null);
      setSessionCookie(svc, reply, token);
      svc.activity.write({ level: "info", area: "auth", message: `Administrator "${user.username}" created`, userId: user.id });
      return { user: { id: user.publicId, username: user.username } };
    },
  );

  // Validation only: nothing is registered. Open to a signed-in admin before and after setup, because
  // Storage settings reuses it when adding a volume.
  r.post(
    "/api/setup/storage/validate",
    {
      config: { auth: "session" },
      schema: { body: z.object({ path: z.string().max(1024), reserveFreeBytes: z.number().int().min(0).optional() }) },
    },
    async (req) => {
      const svc = state.svc;
      try {
        const v = await svc.volumes.validatePath(req.body.path, { reserveFreeBytes: req.body.reserveFreeBytes });
        return {
          ok: true as const,
          path: v.path,
          totalBytes: v.totalBytes,
          freeBytes: v.freeBytes,
          warnings: v.warnings,
          errors: [] as { path: string; message: string }[],
          existingVolume: v.existingMarker !== undefined,
        };
      } catch (e) {
        if (e instanceof AppError && (e.code === "bad_request" || e.code === "conflict")) {
          const fields = (e.details as { fields?: { path: string; message: string }[] } | undefined)?.fields;
          return {
            ok: false as const,
            warnings: [] as string[],
            errors: fields?.length ? fields.map((f) => ({ path: f.path, message: e.message })) : [{ path: "path", message: e.message }],
          };
        }
        throw e;
      }
    },
  );

  r.post(
    "/api/setup/storage",
    {
      config: { auth: "session" },
      schema: {
        body: z.object({
          path: z.string().min(1).max(1024),
          name: z.string().trim().min(1, "Enter a name").max(100),
          quotaBytes: z.number().int().min(1).optional(),
          reserveFreeBytes: z.number().int().min(0).optional(),
        }),
      },
    },
    async (req) => {
      const svc = state.svc;
      assertSetupOpen(svc);
      const user = admin(req);
      if (svc.volumes.list().length > 0) {
        throw new AppError("conflict", "A storage volume is already set up. Add more in Storage settings.");
      }
      const { volume, warnings } = await svc.volumes.register(req.body);
      svc.activity.write({ level: "info", area: "storage", message: `Storage volume "${volume.name}" registered during setup`, details: { path: volume.rootPath, warnings }, userId: user.userId });
      return { volume: svc.volumes.toDto(volume), warnings };
    },
  );

  r.post(
    "/api/setup/profile",
    { config: { auth: "session" }, schema: { body: z.object({ profile: z.enum(["pi-lite", "standard"]) }) } },
    async (req) => {
      const svc = state.svc;
      assertSetupOpen(svc);
      const user = admin(req);
      svc.settings.patch({ resources: { profile: req.body.profile, ...PROFILE_PRESETS[req.body.profile] } }, user.userId);
      setMeta(svc, "setup.profile", req.body.profile);
      return { profile: req.body.profile, resources: svc.settings.get("resources") };
    },
  );

  r.post(
    "/api/setup/providers",
    { config: { auth: "session" }, schema: { body: z.object({ skip: z.boolean().optional(), providers: z.array(z.unknown()).max(20).optional() }) } },
    async (req) => {
      const svc = state.svc;
      assertSetupOpen(svc);
      if (!req.body.skip && (req.body.providers?.length ?? 0) > 0) {
        throw new AppError("not_implemented", "Search providers arrive with online search. Skip this step for now; the app works without any.");
      }
      setMeta(svc, "setup.providers", "skipped");
      return { skipped: true };
    },
  );

  r.post(
    "/api/setup/first-source",
    {
      config: { auth: "session" },
      schema: {
        body: z.object({
          url: z.string().trim().min(1, "Enter a web address").max(4096),
          kind: z.enum(["page", "website"]).default("page"),
          name: z.string().trim().max(120).optional(),
          run: z.boolean().default(false),
        }),
      },
    },
    async (req, reply) => {
      const svc = state.svc;
      assertSetupOpen(svc);
      admin(req);
      const { url, kind, run } = req.body;
      const host = (() => { try { return new URL(url).host; } catch { return url.slice(0, 60); } })();
      let source;
      try {
        // The default profile (balanced) and priority (P3) apply; the Human tunes them later in the Library.
        source = svc.sources.create({ name: req.body.name || host, type: kind === "website" ? "website" : "single_page", startUrl: url });
      } catch (e) {
        // The wizard asks for `url`; the sources API calls it `startUrl`.
        if (e instanceof RequestValidationError) throw new RequestValidationError(e.fields.map((f) => (f.path === "startUrl" ? { ...f, path: "url" } : f)));
        throw e;
      }
      setMeta(svc, "setup.first_source", source.id);
      let downloadIds: string[] | undefined;
      if (run) downloadIds = (await svc.sources.run(source.id, { requestedBy: "user" })).downloadIds;
      void reply.code(201);
      return { source, ...(downloadIds ? { downloadIds } : {}) };
    },
  );

  r.post("/api/setup/complete", { config: { auth: "session" } }, async (req) => {
    const svc = state.svc;
    const user = admin(req);
    if (meta(svc, "setup.complete") === "1") return { complete: true };
    if (svc.volumes.list().length === 0) {
      throw new AppError("conflict", "Add a storage volume before finishing setup.", { fields: [{ in: "body", path: "storage", message: "No storage volume yet." }] });
    }
    setMeta(svc, "setup.complete", "1");
    setMeta(svc, "setup.completed_at", new Date(svc.clock.now()).toISOString());
    svc.activity.write({ level: "info", area: "system", message: "Setup completed", userId: user.userId });
    return { complete: true };
  });
}

export function authRoutes(app: FastifyInstance, state: ServerState): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/auth/login",
    {
      config: { auth: "public" },
      schema: { body: z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(256) }) },
    },
    async (req, reply) => {
      const svc = state.svc;
      if (!svc.auth.hasAdmin()) throw new AppError("setup_required", "Finish the setup wizard first.");
      const ip = clientIp(req);
      // Recorded before the (slow) hash so a burst of concurrent attempts cannot all slip under the limit.
      const wait = svc.throttle.check(ip, req.body.username);
      if (wait > 0) {
        reply.header("retry-after", String(wait));
        throw new AppError("rate_limited", `Too many sign-in attempts. Wait ${wait} second${wait === 1 ? "" : "s"} and try again.`, { retryAfterSeconds: wait });
      }
      const user = await svc.auth.verifyLogin(req.body.username, req.body.password);
      if (!user) {
        svc.activity.write({ level: "warn", area: "auth", message: "Failed sign-in attempt", details: { ip } });
        throw new AppError("unauthorized", "Wrong username or password.");
      }
      svc.throttle.clear(ip, req.body.username);
      const { token } = svc.auth.createSession(user.id, ip, req.headers["user-agent"] ?? null);
      setSessionCookie(svc, reply, token);
      svc.activity.write({ level: "info", area: "auth", message: `"${user.username}" signed in`, userId: user.id, details: { ip } });
      return { user: { id: user.publicId, username: user.username } };
    },
  );

  // Public so that signing out with an expired session still clears the cookie.
  r.post("/api/auth/logout", { config: { auth: "public" } }, async (req, reply) => {
    const svc = state.svc;
    if (req.principal?.kind === "admin") {
      svc.auth.revoke(req.principal.sessionId);
      svc.activity.write({ level: "info", area: "auth", message: "Signed out", userId: req.principal.userId });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  r.get("/api/auth/me", { config: { auth: "guest" } }, async (req) => {
    const p = req.principal;
    if (p?.kind === "admin") return { user: { id: p.publicId, username: p.username }, mode: "admin" as const, csrfRequired: true as const };
    return { user: { id: "guest", username: "Guest" }, mode: "guest" as const, csrfRequired: true as const };
  });

  r.get("/api/auth/sessions", { config: { auth: "session" } }, async (req) => {
    const p = admin(req);
    return { items: state.svc.auth.listSessions(p.userId, p.sessionId) };
  });

  r.delete(
    "/api/auth/sessions",
    { config: { auth: "session" } },
    async (req) => {
      const p = admin(req);
      return { ok: true, revoked: state.svc.auth.revokeAllExcept(p.userId, p.sessionId) };
    },
  );

  r.delete(
    "/api/auth/sessions/:id",
    {
      config: { auth: "session" },
      schema: { params: z.object({ id: z.string().min(1).max(64) }), querystring: z.object({ all: z.enum(["true", "false"]).optional() }) },
    },
    async (req, reply) => {
      const svc = state.svc;
      const p = admin(req);
      if (req.query.all === "true") {
        const revoked = svc.auth.revokeAllExcept(p.userId, p.sessionId);
        svc.activity.write({ level: "info", area: "auth", message: "Other sessions revoked", userId: p.userId, details: { revoked } });
        return { ok: true, revoked };
      }
      if (!svc.auth.revokeByRef(p.userId, req.params.id)) throw new AppError("not_found", "That session does not exist or has already ended.");
      if (req.params.id === p.sessionRef) clearSessionCookie(reply);
      svc.activity.write({ level: "info", area: "auth", message: "Session revoked", userId: p.userId });
      return { ok: true, revoked: 1 };
    },
  );

  r.post(
    "/api/auth/password",
    { config: { auth: "session" }, schema: { body: z.object({ current: z.string().min(1).max(256), next: passwordSchema }) } },
    async (req) => {
      const svc = state.svc;
      const p = admin(req);
      await svc.auth.changePassword(p.userId, req.body.current, req.body.next, p.sessionId);
      svc.activity.write({ level: "info", area: "auth", message: "Administrator password changed; other sessions revoked", userId: p.userId });
      return { ok: true };
    },
  );
}
