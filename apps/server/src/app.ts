import type { Writable } from "node:stream";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { ResolvedConfig } from "@ncb/shared";
import { AppError, isAppError, redactObject, redactText, redactUrl, toApiError, ulid } from "@ncb/shared";
import type { ServerState } from "./context.js";
import { clientIp, proxyVerified } from "./lib/clientip.js";
import { clearSessionCookie, setSessionCookie } from "./lib/http.js";
import { RequestValidationError, validatorCompiler } from "./lib/zod.js";
import { SESSION_COOKIE } from "./services/auth.js";
import { authRoutes, setupRoutes } from "./routes/auth.js";
import { settingsRoutes } from "./routes/settings.js";
import { storageRoutes } from "./routes/storage.js";
import { systemRoutes } from "./routes/system.js";

export interface BuildOptions {
  /** Capture log output (tests). */
  logStream?: Writable;
  /** Global requests per minute per IP. Default 600. */
  rateLimitMax?: number;
  /** SSE heartbeat interval. Default 15 s. */
  sseHeartbeatMs?: number;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const HEALTH = "/api/system/health";

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** One-line human logs for `NCB_LOG_FORMAT=pretty`, without a transport (transports start a thread). */
export function prettyStream(out: NodeJS.WritableStream = process.stdout): Writable {
  const levels: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };
  return {
    write(line: string) {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        const { level, time, msg, pid: _p, hostname: _h, ...rest } = o;
        out.write(`${new Date(Number(time)).toISOString()} ${levels[Number(level)] ?? level} ${msg ?? ""} ${Object.keys(rest).length ? JSON.stringify(rest) : ""}\n`);
      } catch {
        out.write(line);
      }
      return true;
    },
  } as unknown as Writable;
}

export async function buildApp(state: ServerState, config: ResolvedConfig, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const appOrigin = originOf(config.NCB_APP_URL)!;
  const stream = opts.logStream ?? (config.NCB_LOG_FORMAT === "pretty" ? prettyStream() : undefined);

  const app = Fastify({
    genReqId: () => `req_${ulid()}`,
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
    logger: {
      level: config.NCB_LOG_LEVEL,
      ...(stream ? { stream } : {}),
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", 'req.headers["x-nocon-proxy-secret"]', "*.password", "*.current", "*.next", "*.probeToken"],
        censor: "***",
      },
      serializers: {
        req: (req: { method?: string; url?: string; raw?: { url?: string }; hostname?: string; host?: string; ip?: string; socket?: { remoteAddress?: string } }) => ({
          method: req.method, url: redactUrl(req.raw?.url ?? req.url ?? ""), host: req.host ?? req.hostname, remoteAddress: req.ip ?? req.socket?.remoteAddress,
        }),
      },
      // req and res are already reduced and redacted by their serializers.
      formatters: { log: (o: Record<string, unknown>) => { const { req, res, ...rest } = o; return { ...redactObject(rest), ...(req ? { req } : {}), ...(res ? { res } : {}) }; } },
      hooks: {
        logMethod(args, method) {
          const a = args as unknown[];
          if (typeof a[0] === "string") a[0] = redactText(a[0]);
          else if (typeof a[1] === "string") a[1] = redactText(a[1]);
          return (method as (...x: unknown[]) => void).apply(this, a);
        },
      },
    },
  });
  app.decorate("proxySecret", config.NCB_PROXY_SECRET ?? "");
  app.setValidatorCompiler(validatorCompiler);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => clientIp(req),
    allowList: (req) => req.url.split("?")[0] === HEALTH,
    errorResponseBuilder: (_req, ctx) => {
      const seconds = Math.max(1, Math.ceil(ctx.ttl / 1000));
      return new AppError("rate_limited", `Too many requests. Wait ${seconds} second${seconds === 1 ? "" : "s"} and try again.`, { retryAfterSeconds: seconds });
    },
  });

  // An empty JSON body (POST with Content-Type: application/json and no payload) means "no body".
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError("bad_request", "The request body is not valid JSON."));
    }
  });

  // ---- every request ------------------------------------------------------------------------

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    if (!req.url.startsWith("/api")) return;
    const path = req.url.split("?")[0]!;

    // 1. Not ready: only the health endpoint answers while migrations run or the server stops.
    if (path !== HEALTH && !state.ready) {
      const message = state.phase === "stopping" ? "The server is shutting down." : "The server is still starting. Try again in a few seconds.";
      return reply.code(503).header("retry-after", "2").send({ error: "internal", message, requestId: req.id });
    }

    // 2. Cross-site protection: CSRF header plus Origin for mutations, fetch metadata for everything.
    const csrf = header(req, "x-nocon-csrf") === "1";
    const originHeader = header(req, "origin");
    const refererHeader = header(req, "referer");
    const origin = originOf(originHeader);
    const refererOrigin = originOf(refererHeader);
    const originBad = (originHeader !== undefined && origin !== appOrigin) || (originHeader === undefined && refererHeader !== undefined && refererOrigin !== appOrigin);

    if (!SAFE.has(req.method)) {
      if (!csrf) throw new AppError("csrf", "This request is missing its protection header. Reload the page and try again.");
      if (originBad) throw new AppError("csrf", "This request came from a different website than the app. Reload the page and try again.");
    }
    const site = header(req, "sec-fetch-site");
    if (site === "same-site" || site === "cross-site") {
      if (!(csrf && origin === appOrigin)) throw new AppError("csrf", "Requests from another origin are not allowed.");
    }

    // 3. Who is calling, and may they?
    const level = req.is404 ? undefined : (req.routeOptions.config.auth ?? "session");
    if (level === undefined) return;
    if (!state.ready) return; // only the public health route gets here before the database is open
    const svc = state.svc;

    const token = req.cookies?.[SESSION_COOKIE];
    const resolved = svc.auth.resolve(token);
    if (resolved) {
      req.principal = resolved.principal;
      if (resolved.touched && token) setSessionCookie(svc, reply, token);
    } else if (token) {
      clearSessionCookie(reply);
    }
    if (level === "public") return;
    if (!svc.auth.hasAdmin()) throw new AppError("setup_required", "Finish the setup wizard first.");
    if (req.principal) return;

    if (svc.guestMatcher && svc.guestMatcher(clientIp(req))) {
      if (level === "guest" && SAFE.has(req.method)) {
        req.principal = { kind: "guest" };
        return;
      }
      if (!SAFE.has(req.method)) throw new AppError("forbidden", "Guests on the local network can browse and search, but cannot change anything. Sign in to make changes.");
    }
    throw new AppError("unauthorized", "Sign in to continue.");
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (req.url.startsWith("/api")) {
      reply.header("x-frame-options", "DENY");
      reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    }
    return payload;
  });

  // ---- errors -------------------------------------------------------------------------------

  app.setErrorHandler((err: FastifyError | AppError | RequestValidationError | Error, req, reply) => {
    let status: number;
    let body: ReturnType<typeof toApiError>["body"];
    if (err instanceof RequestValidationError) {
      status = 400;
      body = { error: "bad_request", message: "Some values are not valid. Check the fields and try again.", details: { fields: err.fields }, requestId: req.id };
    } else if (isAppError(err)) {
      ({ status, body } = toApiError(err, req.id));
      if (err.code === "rate_limited") {
        const s = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        if (s) reply.header("retry-after", String(s));
      }
    } else {
      const fe = err as FastifyError;
      const sc = fe.statusCode;
      if (sc && sc >= 400 && sc < 500) {
        const map: Record<number, ReturnType<typeof toApiError>["body"]["error"]> = { 404: "not_found", 429: "rate_limited" };
        status = sc;
        const message =
          sc === 413 ? "That request is too large." : sc === 415 ? "Send the request as JSON." : sc === 400 ? "The request could not be read. Check it and try again." : "The request could not be completed.";
        body = { error: map[sc] ?? "bad_request", message, requestId: req.id };
      } else {
        req.log.error({ err: { name: err.name, message: err.message } }, "request failed");
        ({ status, body } = toApiError(err, req.id));
      }
    }
    if (status >= 500 && isAppError(err) && err.code === "internal") req.log.warn({ code: err.code }, redactText(err.message));
    void reply.code(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: "not_found", message: "There is nothing at this address.", requestId: req.id });
  });

  // ---- routes -------------------------------------------------------------------------------

  const sseHeartbeatMs = opts.sseHeartbeatMs ?? 15_000;
  await app.register(async (a) => {
    systemRoutes(a, state, { sseHeartbeatMs, proxyVerified });
    setupRoutes(a, state);
    authRoutes(a, state);
    settingsRoutes(a, state);
    storageRoutes(a, state);
  });

  return app;
}
