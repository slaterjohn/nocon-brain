import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt N=2^15, r=8, p=1, 16-byte salt, 64-byte key (docs/data-model.md users.password_hash).
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

/** At most MAX_SCRYPT hashes run at once (each needs about 32 MiB and a libuv thread); the rest queue. */
export const MAX_SCRYPT = 2;
let active = 0;
let started = 0;
const waiting: Array<() => void> = [];

export function scryptStats() {
  return { active, queued: waiting.length, started };
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_SCRYPT) await new Promise<void>((res) => waiting.push(res));
  else active++;
  started++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight to the next waiter
    else active--;
  }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return withSlot(
    () => new Promise<Buffer>((res, rej) => scrypt(password, salt, KEYLEN, SCRYPT, (e, k) => (e ? rej(e) : res(k)))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, , , , saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await derive(password, Buffer.from(saltB64, "base64"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");
