import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { ClockJumpDetector, isExpired, type Clock } from "@ncb/shared";

/** Default lifetime of an archive capability: 8 hours (docs/api.md section 5). */
export const TOKEN_LIFETIME_SECONDS = 8 * 3600;

export interface TokenPayload {
  /** User id. */
  u: string;
  /** Frame id: the listener records the last top-level document served per frame (D-5). */
  f: string;
  /** Expiry, Unix seconds. */
  e: number;
  /** App origin allowed to frame responses (`frame-ancestors`). */
  o: string;
}

export type TokenFailure = "malformed" | "bad-signature" | "expired" | "wrong-frame";

export type VerifyResult = { ok: true; payload: TokenPayload } | { ok: false; reason: TokenFailure };

const PREFIX = "v1";
const MAX_TOKEN_LENGTH = 1024;

/** Derives the HMAC key from `NCB_SECRET_KEY` material. Rotating the secret invalidates every token. */
export function deriveTokenKey(secret: Buffer | string): Buffer {
  const ikm = typeof secret === "string" ? Buffer.from(secret) : secret;
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), "ncb-archive-token-v1", 32));
}

export interface TokenServiceOptions {
  /** Raw secret key material (already hashed by `loadSecretKey`). */
  secret: Buffer | string;
  clock: Clock;
  lifetimeSeconds?: number;
  /** When given, an expiry never fires inside the grace period after a clock jump (F-18). */
  jumps?: ClockJumpDetector;
}

/**
 * Mints and verifies `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>` capability tokens. Stateless: nothing is stored,
 * so the listener needs no database to authorise a request.
 */
export class ArchiveTokenService {
  private readonly key: Buffer;
  private readonly clock: Clock;
  private readonly lifetime: number;
  private readonly jumps?: ClockJumpDetector;

  constructor(opts: TokenServiceOptions) {
    this.key = deriveTokenKey(opts.secret);
    this.clock = opts.clock;
    this.lifetime = opts.lifetimeSeconds ?? TOKEN_LIFETIME_SECONDS;
    this.jumps = opts.jumps;
  }

  private sign(body: string): Buffer {
    return createHmac("sha256", this.key).update(`${PREFIX}.${body}`).digest();
  }

  mint(input: { userId: string; frameId: string; appOrigin: string; lifetimeSeconds?: number }): string {
    const payload: TokenPayload = {
      u: input.userId,
      f: input.frameId,
      e: Math.floor(this.clock.now() / 1000) + (input.lifetimeSeconds ?? this.lifetime),
      o: new URL(input.appOrigin).origin,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${PREFIX}.${body}.${this.sign(body).toString("base64url")}`;
  }

  /** Checks signature, then expiry, then (optionally) that the token belongs to the expected frame. */
  verify(token: string, expect: { frameId?: string } = {}): VerifyResult {
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
    const given = Buffer.from(parts[2], "base64url");
    const want = this.sign(parts[1]);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: "bad-signature" };
    let payload: TokenPayload;
    try {
      const raw = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Partial<TokenPayload>;
      if (typeof raw.u !== "string" || typeof raw.f !== "string" || typeof raw.e !== "number" || typeof raw.o !== "string") {
        return { ok: false, reason: "malformed" };
      }
      payload = { u: raw.u, f: raw.f, e: raw.e, o: raw.o };
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (isExpired(payload.e * 1000, this.clock, this.jumps)) return { ok: false, reason: "expired" };
    if (expect.frameId !== undefined && expect.frameId !== payload.f) return { ok: false, reason: "wrong-frame" };
    return { ok: true, payload };
  }
}
