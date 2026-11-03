import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    /** NCB_PROXY_SECRET, or "" when unset. */
    proxySecret: string;
    /** Every route that was registered, with its declared access level (read by the authorisation matrix test, H-03). */
    routeTable: RouteEntry[];
    /** Source addresses the proxy secret counts from (`NCB_API_PROXY_FROM`), or null for anywhere. */
    proxyFrom: ((ip: string) => boolean) | null;
  }
}

export interface RouteEntry {
  method: string;
  url: string;
  auth: "public" | "guest" | "session";
  guestPost: boolean;
}

const verified = new WeakMap<FastifyRequest, boolean>();

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** True when the request carries the shared proxy secret, i.e. it really came from the `web` container. */
export function proxyVerified(req: FastifyRequest): boolean {
  const cached = verified.get(req);
  if (cached !== undefined) return cached;
  const secret = req.server.proxySecret;
  let ok = false;
  const given = header(req, "x-nocon-proxy-secret");
  if (secret && given) {
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    ok = a.length === b.length && timingSafeEqual(a, b);
    // A copy of the secret is worth nothing from the wrong network (the renderer holds one by default). No socket address: an injected test request.
    const from = req.socket?.remoteAddress;
    if (ok && from && req.server.proxyFrom && !req.server.proxyFrom(from)) ok = false;
  }
  verified.set(req, ok);
  return ok;
}

/** The caller's IP: `x-nocon-client-ip` when the proxy secret matches, otherwise the socket address. */
export function clientIp(req: FastifyRequest): string {
  if (proxyVerified(req)) {
    const ip = header(req, "x-nocon-client-ip")?.trim();
    if (ip && isIP(ip)) return ip;
  }
  return req.ip;
}

/** `X-Forwarded-Host` is only honoured with a valid proxy secret. */
export function forwardedHost(req: FastifyRequest): string | undefined {
  if (!proxyVerified(req)) return undefined;
  const v = header(req, "x-forwarded-host");
  return v ? v.split(",")[0]!.trim() : undefined;
}
