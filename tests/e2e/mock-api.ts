/**
 * Minimal mock of the docs/api.md endpoints the web shell uses. Used when the real server is not available
 * (default). It is deliberately strict: it rejects mutating calls without the CSRF header, and any call that
 * does not carry the proxy secret, so a regression in the web proxy shows up as a failing test.
 */
import crypto from "node:crypto";
import http from "node:http";

export interface MockOptions {
  port: number;
  proxySecret: string;
  allowedRoot: string;
}

interface State {
  admin?: { username: string; password: string };
  sessions: Set<string>;
  storage: boolean;
  profile?: string;
  complete: boolean;
  forceOffline: boolean;
}

const LEVELS = ["debug", "info", "warn", "error"] as const;
const AREAS = ["crawl", "pipeline", "storage", "search", "auth", "system", "zim", "provider"] as const;
const LOG_TOTAL = 130;

export function startMockApi(opts: MockOptions): Promise<{ close: () => Promise<void> }> {
  const state: State = { sessions: new Set(), storage: false, complete: false, forceOffline: false };
  const streams = new Set<http.ServerResponse>();
  const logs = Array.from({ length: LOG_TOTAL }, (_, i) => ({
    id: String(LOG_TOTAL - i),
    at: new Date(Date.UTC(2026, 10, 1, 12, 0, 0) - i * 60_000).toISOString(),
    level: LEVELS[i % LEVELS.length]!,
    area: AREAS[i % AREAS.length]!,
    message: `Mock log entry ${LOG_TOTAL - i}`,
  }));

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const err = (res: http.ServerResponse, status: number, error: string, message: string, details?: unknown) =>
    json(res, status, { error, message, details, requestId: "mock" });

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          resolve({});
        }
      });
    });

  const broadcastConnectivity = () => {
    const data = JSON.stringify({ state: state.forceOffline ? "offline" : "online", source: state.forceOffline ? "forced" : "probe" });
    for (const s of streams) s.write(`event: connectivity\ndata: ${data}\n\n`);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const p = url.pathname;
    const method = req.method ?? "GET";

    // The proxy must stamp the shared secret on everything it forwards.
    if (req.headers["x-nocon-proxy-secret"] !== opts.proxySecret) {
      return err(res, 403, "forbidden", "Missing or wrong proxy secret.");
    }
    const cookie = /(?:^|;\s*)ncb_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const signedIn = !!cookie && state.sessions.has(cookie);
    if (method !== "GET" && method !== "HEAD" && req.headers["x-nocon-csrf"] !== "1") {
      return err(res, 403, "csrf", "The request is missing its CSRF header.");
    }

    // Test helpers (reached through the proxy as /api/_mock/...).
    if (p === "/api/_mock/headers") return json(res, 200, req.headers);
    if (p === "/api/_mock/slow-sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      // Event 1 is sent 300 ms after connect so the client can tell "streamed" from "buffered until close".
      const send = (n: number) => res.write(`id: ${n}\nevent: tick\ndata: ${JSON.stringify({ n, sentAt: Date.now() })}\n\n`);
      const t1 = setTimeout(() => send(1), 300);
      const t2 = setInterval(() => send(2), 700);
      req.on("close", () => {
        clearTimeout(t1);
        clearInterval(t2);
      });
      return;
    }

    if (p === "/api/system/health") return json(res, 200, { status: "ok" });

    if (p === "/api/setup/status" && method === "GET") {
      return json(res, 200, {
        adminExists: !!state.admin,
        storageConfigured: state.storage,
        profile: state.profile ?? null,
        firstSourceCreated: false,
        complete: state.complete,
      });
    }
    if (p === "/api/setup/admin" && method === "POST") {
      if (state.admin) return err(res, 409, "conflict", "An administrator already exists.");
      const b = await readBody(req);
      if (typeof b.username !== "string" || b.username.length < 3) return err(res, 400, "bad_request", "Invalid username.", { fields: [{ in: "body", path: "username", message: "Use at least 3 characters." }] });
      if (typeof b.password !== "string" || b.password.length < 10) return err(res, 400, "bad_request", "Invalid password.", { fields: [{ in: "body", path: "password", message: "Use at least 10 characters." }] });
      // Does not sign in: the wizard has to cope with that.
      state.admin = { username: b.username, password: b.password };
      return json(res, 201, { user: { username: b.username } });
    }

    if (p === "/api/auth/login" && method === "POST") {
      const b = await readBody(req);
      if (!state.admin) return err(res, 409, "setup_required", "Create the administrator account first.");
      if (b.username !== state.admin.username || b.password !== state.admin.password) {
        return err(res, 401, "unauthorized", "The username or password is wrong.");
      }
      const token = crypto.randomBytes(16).toString("hex");
      state.sessions.add(token);
      return json(res, 200, { user: { username: state.admin.username } }, { "set-cookie": `ncb_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (p === "/api/auth/logout" && method === "POST") {
      if (cookie) state.sessions.delete(cookie);
      return json(res, 200, { ok: true }, { "set-cookie": "ncb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
    }
    if (p === "/api/auth/me") {
      if (!signedIn) return err(res, 401, "unauthorized", "Sign in first.");
      return json(res, 200, { user: { username: state.admin!.username }, mode: "admin", csrfRequired: true });
    }

    if (p === "/api/system/connectivity" && method === "GET") {
      return json(res, 200, { state: state.forceOffline ? "offline" : "online", since: new Date().toISOString(), source: state.forceOffline ? "forced" : "probe" });
    }

    // Everything below needs a session.
    if (!signedIn) return err(res, 401, "unauthorized", "Sign in first.");

    if (p === "/api/system/connectivity" && method === "POST") {
      const b = await readBody(req);
      state.forceOffline = !!b.forceOffline;
      broadcastConnectivity();
      return json(res, 200, { state: state.forceOffline ? "offline" : "online", source: "forced" });
    }
    if (p === "/api/system/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      streams.add(res);
      broadcastConnectivity();
      const hb = setInterval(() => res.write(`event: heartbeat\ndata: {}\n\n`), 5000);
      req.on("close", () => {
        clearInterval(hb);
        streams.delete(res);
      });
      return;
    }

    if (p === "/api/setup/storage" && method === "POST") {
      const b = await readBody(req);
      const root = opts.allowedRoot;
      if (typeof b.path !== "string" || !(b.path === root || b.path.startsWith(`${root}/`))) {
        return err(res, 400, "bad_request", `That folder isn't inside an allowed storage root (${root}). Choose a folder under it.`, { fields: [{ in: "body", path: "path", message: "Choose a folder inside the allowed storage root." }] });
      }
      state.storage = true;
      const warnings = b.path.includes("container") ? ["on_container_filesystem"] : [];
      return json(res, 200, {
        volume: { id: "vol_1", name: b.name, rootPath: b.path, state: "online", isDefault: true, capacityBytes: 100e9, usedBytes: 0, availableBytes: 100e9, reservedBytes: 0, reserveFreeBytes: 5e9 },
        warnings,
      });
    }
    if (p === "/api/setup/profile" && method === "POST") {
      const b = await readBody(req);
      state.profile = b.profile;
      return json(res, 200, { profile: b.profile });
    }
    if (p === "/api/setup/providers" && method === "POST") return json(res, 200, { ok: true });
    if (p === "/api/setup/first-source" && method === "POST") return json(res, 200, { ok: true });
    if (p === "/api/setup/complete" && method === "POST") {
      state.complete = true;
      return json(res, 200, { complete: true });
    }

    if (p === "/api/system/dashboard") {
      return json(res, 200, {
        pages: { total: 0, archived: 0, partial: 0, evicted: 0 },
        sources: { total: 0, enabled: 0 },
        collections: 0,
        index: { docs: 0, sizeBytes: 0, drift: 0, state: "ok" },
        storage: { usedBytes: 2_500_000_000, availableBytes: 97_500_000_000, byPriority: { P1: 0, P2: 0, P3: 0, P4: 0 } },
        jobs: { active: 2, queued: 7, failedLast24h: 1 },
        workers: [
          { name: "runner", state: "busy", lastHeartbeatAt: new Date().toISOString(), memoryMb: 120 },
          { name: "extract", state: "idle", lastHeartbeatAt: new Date().toISOString(), memoryMb: 80 },
          { name: "index", state: "idle", lastHeartbeatAt: new Date().toISOString(), memoryMb: 64 },
          { name: "renderer", state: "disabled" },
        ],
        connectivity: state.forceOffline ? "offline" : "online",
      });
    }
    if (p === "/api/system/logs") {
      const level = url.searchParams.get("level");
      const area = url.searchParams.get("area");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const filtered = logs.filter((l) => (!level || l.level === level) && (!area || l.area === area));
      const items = filtered.slice(offset, offset + limit);
      const nextCursor = offset + limit < filtered.length ? String(offset + limit) : undefined;
      return json(res, 200, { items, nextCursor, total: filtered.length });
    }

    return err(res, 404, "not_found", `No mock for ${method} ${p}.`);
  });

  return new Promise((resolve) => {
    server.listen(opts.port, "127.0.0.1", () =>
      resolve({
        close: () =>
          new Promise<void>((r) => {
            for (const s of streams) s.end();
            server.closeAllConnections();
            server.close(() => r());
          }),
      }),
    );
  });
}
