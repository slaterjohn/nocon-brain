import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE, SESSION_SLIDING_MS } from "../services/auth.js";
import type { Services } from "../context.js";
import type { AdminPrincipal } from "../services/auth.js";
import { AppError } from "@ncb/shared";

declare module "fastify" {
  interface FastifyContextConfig {
    /** `public` needs nothing, `guest` also allows a trusted-LAN guest on GET, `session` (default) needs a sign-in. */
    auth?: "public" | "guest" | "session";
  }
  interface FastifyRequest {
    principal?: import("../services/auth.js").Principal;
  }
}

export function setSessionCookie(svc: Pick<Services, "config">, reply: FastifyReply, token: string): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: svc.config.NCB_COOKIE_SECURE,
    path: "/",
    maxAge: SESSION_SLIDING_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** The signed-in admin. Throws 401 for a guest, which cannot reach `session` routes anyway. */
export function admin(req: FastifyRequest): AdminPrincipal {
  if (req.principal?.kind !== "admin") throw new AppError("unauthorized", "Sign in to continue.");
  return req.principal;
}

export const iso = (ms: number | null | undefined): string | undefined => (ms == null ? undefined : new Date(ms).toISOString());
