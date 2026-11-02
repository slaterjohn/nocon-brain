import { randomBytes } from "node:crypto";

/** Prefixes from docs/data-model.md section 1 (D-9). */
export const ID_PREFIXES = [
  "usr", "src", "col", "pg", "ver", "job", "dl", "vol", "prv", "cand", "zim", "bm", "ss", "hs", "sch", "win", "plan", "tmp", "evr", "mnt",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_MAX = (1n << 80n) - 1n;

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const PUBLIC_ID_PATTERN = /^([a-z]{2,4})_([0-9A-HJKMNP-TV-Z]{26})$/;

function encode(value: bigint, length: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

function decodeChar(c: string): bigint {
  const i = ALPHABET.indexOf(c);
  if (i < 0) throw new Error(`Invalid ULID character: ${c}`);
  return BigInt(i);
}

export interface UlidOptions {
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
}

/**
 * A monotonic ULID generator. IDs from one factory always sort strictly ascending as strings, even
 * within one millisecond or when the clock steps backwards (the previous timestamp is kept and the
 * random part is incremented).
 */
export function createUlidFactory(opts: UlidOptions = {}): () => string {
  const now = opts.now ?? Date.now;
  const rand = opts.randomBytes ?? ((n: number) => randomBytes(n));
  let lastTime = -1;
  let lastRandom = 0n;
  return () => {
    let t = now();
    let r: bigint;
    if (t <= lastTime) {
      t = lastTime;
      r = lastRandom + 1n;
      if (r > RANDOM_MAX) {
        t += 1; // 2^80 ids in one millisecond: carry into the timestamp
        r = 0n;
      }
    } else {
      r = BigInt("0x" + Buffer.from(rand(10)).toString("hex"));
    }
    lastTime = t;
    lastRandom = r;
    return encode(BigInt(t), TIME_LEN) + encode(r, RANDOM_LEN);
  };
}

const defaultUlid = createUlidFactory();

export function ulid(): string {
  return defaultUlid();
}

export function newId(prefix: IdPrefix, generate: () => string = defaultUlid): string {
  return `${prefix}_${generate()}`;
}

export function isPublicId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== "string") return false;
  const m = PUBLIC_ID_PATTERN.exec(value);
  if (!m) return false;
  return prefix === undefined || m[1] === prefix;
}

/** Millisecond timestamp encoded in a ULID or prefixed id. */
export function idTimestamp(id: string): number {
  const body = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
  if (!ULID_PATTERN.test(body)) throw new Error("Not a ULID");
  let t = 0n;
  for (const c of body.slice(0, TIME_LEN)) t = (t << 5n) | decodeChar(c);
  return Number(t);
}
