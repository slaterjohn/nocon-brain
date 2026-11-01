import { randomBytes } from "node:crypto";
import type { Clock } from "@ncb/shared";
import { AppError, ClockJumpDetector, isExpired, newId } from "@ncb/shared";
import type { Db } from "@ncb/db";
import { hashPassword, sha256Hex, verifyPassword } from "../lib/password.js";

export const SESSION_COOKIE = "ncb_session";
export const SESSION_SLIDING_MS = 30 * 86_400_000;
export const SESSION_ABSOLUTE_MS = 90 * 86_400_000;
/** `last_seen_at` and the sliding expiry are written at most this often per session. */
const TOUCH_INTERVAL_MS = 60_000;

export interface AdminPrincipal {
  kind: "admin";
  userId: number;
  publicId: string;
  username: string;
  sessionId: number;
  sessionRef: string;
}
export interface GuestPrincipal {
  kind: "guest";
}
export type Principal = AdminPrincipal | GuestPrincipal;

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
  ip: string | null;
  user_agent: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** The public id of a session is the first 16 hex characters of its token hash. */
const refOf = (tokenHash: string) => tokenHash.slice(0, 16);

export class AuthService {
  private adminKnown = false;
  private dummyHash?: Promise<string>;
  readonly jumps: ClockJumpDetector;

  constructor(private readonly db: Db, private readonly clock: Clock, jumps?: ClockJumpDetector) {
    this.jumps = jumps ?? new ClockJumpDetector({ clock });
  }

  /** The oldest enabled administrator. Trusted-LAN guests read this user's bookmarks. */
  firstAdminId(): number | null {
    return this.db.get<{ id: number }>("SELECT id FROM users WHERE disabled_at IS NULL ORDER BY id LIMIT 1")?.id ?? null;
  }

  hasAdmin(): boolean {
    if (this.adminKnown) return true;
    const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
    this.adminKnown = n > 0;
    return this.adminKnown;
  }

  /**
   * Creates the first admin. The existence check runs before the slow hash, and again inside the write
   * transaction so two concurrent setups cannot both succeed.
   */
  async createAdmin(username: string, password: string): Promise<{ id: number; publicId: string; username: string }> {
    const refuse = () => new AppError("conflict", "An administrator already exists. Sign in instead.");
    if (this.hasAdmin()) throw refuse();
    const hash = await hashPassword(password);
    return this.db.transaction(() => {
      const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n;
      if (n > 0) throw refuse();
      const publicId = newId("usr");
      const now = this.clock.now();
      const r = this.db.run(
        "INSERT INTO users (public_id, username, password_hash, role, created_at, last_login_at) VALUES (?, ?, ?, 'admin', ?, ?)",
        [publicId, username, hash, now, now],
      );
      this.adminKnown = true;
      return { id: Number(r.lastInsertRowid), publicId, username };
    });
  }

  /** Verifies credentials. Runs a dummy hash for unknown users so timing does not reveal which usernames exist. */
  async verifyLogin(username: string, password: string): Promise<{ id: number; publicId: string; username: string } | null> {
    const u = this.db.get<{ id: number; public_id: string; username: string; password_hash: string; disabled_at: number | null }>(
      "SELECT id, public_id, username, password_hash, disabled_at FROM users WHERE username = ?",
      [username],
    );
    this.dummyHash ??= hashPassword("not-a-real-password");
    const ok = await verifyPassword(password, u?.password_hash ?? (await this.dummyHash));
    if (!u || !ok || u.disabled_at !== null) return null;
    this.db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [this.clock.now(), u.id]);
    return { id: u.id, publicId: u.public_id, username: u.username };
  }

  createSession(userId: number, ip: string | null, userAgent: string | null): { token: string; maxAgeSeconds: number } {
    const token = randomBytes(32).toString("base64url");
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, sha256Hex(token), now, now, now + SESSION_SLIDING_MS, now + SESSION_ABSOLUTE_MS, ip, userAgent?.slice(0, 300) || null],
    );
    return { token, maxAgeSeconds: SESSION_SLIDING_MS / 1000 };
  }

  /**
   * Resolves a session cookie. Expiry is sliding (30 days from last use) and absolute (90 days from
   * creation). Both go through `isExpired`, so a wall-clock jump cannot expire every session at once.
   * Returns `touched` when the cookie lifetime was extended and should be re-sent.
   */
  resolve(token: string | undefined): { principal: AdminPrincipal; touched: boolean } | null {
    if (!token) return null;
    const row = this.db.get<SessionRow & { public_id: string; username: string; disabled_at: number | null }>(
      `SELECT s.*, u.public_id, u.username, u.disabled_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      [sha256Hex(token)],
    );
    if (!row || row.revoked_at !== null || row.disabled_at !== null) return null;
    if (isExpired(row.absolute_expires_at, this.clock, this.jumps) || isExpired(row.expires_at, this.clock, this.jumps)) return null;

    const now = this.clock.now();
    let touched = false;
    if (now - row.last_seen_at > TOUCH_INTERVAL_MS && !this.jumps.inGrace()) {
      const expiresAt = Math.min(now + SESSION_SLIDING_MS, row.absolute_expires_at);
      this.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", [now, expiresAt, row.id]);
      touched = true;
    }
    return {
      touched,
      principal: { kind: "admin", userId: row.user_id, publicId: row.public_id, username: row.username, sessionId: row.id, sessionRef: refOf(row.token_hash) },
    };
  }

  revoke(sessionId: number): void {
    this.db.run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [this.clock.now(), sessionId]);
  }

  /** Revokes by public ref. Returns false when the user has no such live session. */
  revokeByRef(userId: number, ref: string): boolean {
    const r = this.db.run(
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND substr(token_hash, 1, 16) = ? AND revoked_at IS NULL",
      [this.clock.now(), userId, ref],
    );
    return r.changes > 0;
  }

  revokeAllExcept(userId: number, keepSessionId: number): number {
    return this.db.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL", [
      this.clock.now(), userId, keepSessionId,
    ]).changes;
  }

  listSessions(userId: number, currentSessionId: number): SessionInfo[] {
    const now = this.clock.now();
    return this.db
      .all<SessionRow>(
        `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ? ORDER BY last_seen_at DESC, id DESC`,
        [userId, now, now],
      )
      .map((s) => ({
        id: refOf(s.token_hash),
        createdAt: iso(s.created_at),
        lastSeenAt: iso(s.last_seen_at),
        expiresAt: iso(Math.min(s.expires_at, s.absolute_expires_at)),
        ip: s.ip,
        userAgent: s.user_agent,
        current: s.id === currentSessionId,
      }));
  }

  /** Changes the password after checking the current one; revokes every other session. */
  async changePassword(userId: number, current: string, next: string, keepSessionId: number): Promise<void> {
    const u = this.db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [userId]);
    if (!u || !(await verifyPassword(current, u.password_hash))) {
      throw new AppError("bad_request", "The current password is wrong.", { fields: [{ in: "body", path: "current", message: "That is not your current password." }] });
    }
    const hash = await hashPassword(next);
    this.db.transaction(() => {
      this.db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, userId]);
      this.revokeAllExcept(userId, keepSessionId);
    }, { durable: true });
  }

  /** Removes sessions that can never be used again. Skipped shortly after a clock jump. */
  sweepExpired(): number {
    if (this.jumps.inGrace()) return 0;
    const now = this.clock.now();
    return this.db.run("DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR absolute_expires_at < ? OR expires_at < ?", [
      now - 7 * 86_400_000, now, now,
    ]).changes;
  }
}
