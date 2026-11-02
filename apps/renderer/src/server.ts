import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Engine, RenderError, type RenderInput } from "./engine.js";

/**
 * The renderer's HTTP API. It does one thing: `POST /render {url}` returns the page's DOM after its scripts ran.
 * It never touches the database. Its browser reaches the web only through the server's guarded forward proxy.
 */
const env = process.env;
const port = Number(env.PORT ?? 8080);
const secret = env.NCB_RENDERER_SECRET ?? "";
const proxyUrl = env.NCB_RENDER_PROXY_URL ?? "";
if (!proxyUrl) {
  console.error("NCB_RENDER_PROXY_URL is required (for example http://server:3128). The renderer has no other route to the web.");
  process.exit(2);
}
const engine = new Engine({ proxyUrl, proxyPassword: secret || undefined, restartAfterPages: Number(env.NCB_RENDERER_RESTART_AFTER_PAGES ?? 50) });

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function authorised(req: http.IncomingMessage): boolean {
  if (!secret) return true;
  const h = req.headers.authorization ?? "";
  const a = Buffer.from(h);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req: http.IncomingMessage, max = 8192): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) { reject(new RenderError("bad_request", "The request is too large.", 400)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new RenderError("bad_request", "The request is not valid JSON.", 400)); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, browser: engine.browserUp, busy: engine.isBusy, pagesRendered: engine.pagesRendered });
    if (req.method === "POST" && req.url === "/render") {
      if (!authorised(req)) return send(res, 401, { error: "unauthorised", message: "Missing or wrong bearer token." });
      const body = (await readJson(req)) as Partial<RenderInput>;
      if (typeof body.url !== "string") throw new RenderError("bad_request", "url is required.", 400);
      const input: RenderInput = {
        url: body.url,
        timeoutMs: Math.min(Math.max(Number(body.timeoutMs) || 45_000, 3_000), 300_000),
        maxBytes: Math.min(Math.max(Number(body.maxBytes) || 20 * 1024 * 1024, 64 * 1024), 100 * 1024 * 1024),
        userAgent: typeof body.userAgent === "string" && body.userAgent.length < 300 ? body.userAgent : "NoConBrain-Renderer",
      };
      return send(res, 200, await engine.render(input));
    }
    send(res, 404, { error: "not_found", message: "Unknown route." });
  } catch (e) {
    if (e instanceof RenderError) return send(res, e.httpStatus, { error: e.code, message: e.message });
    console.error("render failed:", e);
    send(res, 500, { error: "internal", message: "The renderer failed." });
  }
});
server.requestTimeout = 30_000;
server.listen(port, env.HOST ?? "0.0.0.0", () => console.log(`renderer listening on :${port}, proxy ${proxyUrl}`));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    void engine.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
