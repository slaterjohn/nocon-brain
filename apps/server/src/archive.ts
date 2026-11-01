import http from "node:http";

/**
 * The archive listener (docs/architecture.md section 8). A separate `http.Server` with its own tiny route
 * table: read-only, no sessions, no auth, no API. It never reads the `Cookie` header and never sets one,
 * because cookies cross ports and the archive origin is untrusted. Content routes (`/a/{token}/...`) arrive
 * in Phase 2; today it only answers a health check.
 */
export function archiveHeaders(appUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  let appOrigin = "'none'";
  try {
    appOrigin = new URL(appUrl).origin;
  } catch {
    /* keep 'none' */
  }
  return {
    "content-security-policy":
      "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self'; " +
      `frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors ${appOrigin}`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    ...extra,
  };
}

const HEALTH_PATHS = new Set(["/healthz", "/__health"]);

export function createArchiveServer(opts: { appUrl: string }): http.Server {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, archiveHeaders(opts.appUrl, { "content-type": "text/plain; charset=utf-8", ...extra }));
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(405, "Method not allowed.\n", { allow: "GET, HEAD" });
      return;
    }
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://archive.invalid").pathname;
    } catch {
      send(400, "Bad request.\n");
      return;
    }
    if (HEALTH_PATHS.has(pathname)) {
      send(200, "ok\n");
      return;
    }
    send(404, "Not found.\n");
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
