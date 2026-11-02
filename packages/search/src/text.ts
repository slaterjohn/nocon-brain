/** Text helpers shared by indexing and querying: tokenising, snippet markers, escaping, fingerprints. */

/** Private control characters that stand for <mark> and </mark> until the text has been escaped (S-09). */
export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** Page text as stored in the index: control characters (including our marker characters) removed. */
export function cleanText(s: string | null | undefined): string {
  return (s ?? "").replace(CONTROL, " ");
}

const COMBINING = /\p{M}+/gu;
/** Lower case, accents removed. Mirrors the `unicode61 remove_diacritics 2` folding closely enough for the vocabulary. */
export function fold(s: string): string {
  return s.normalize("NFKD").replace(COMBINING, "").toLowerCase();
}

const TOKEN = /[\p{L}\p{N}]+/gu;
/** Words as the index sees them: folded letter and digit runs. */
export function tokenize(s: string): string[] {
  return fold(s).match(TOKEN) ?? [];
}

/** The folded form of a whole title, used for exact-title matches: words joined by one space. */
export function normTitle(s: string): string {
  return tokenize(s).join(" ");
}

/** Escapes text for HTML, then turns the marker characters into the only allowed tags. */
export function sanitiseMarked(s: string): string {
  let out = "";
  let open = false;
  for (const ch of s) {
    if (ch === MARK_OPEN) {
      if (!open) { out += "<mark>"; open = true; }
    } else if (ch === MARK_CLOSE) {
      if (open) { out += "</mark>"; open = false; }
    } else if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&#39;";
    else if (ch.charCodeAt(0) < 0x20 && ch !== "\n" && ch !== "\t") continue;
    else out += ch;
  }
  if (open) out += "</mark>";
  return out;
}

/** Escapes text with no markup at all. */
export function escapeHtml(s: string): string {
  return sanitiseMarked(s.replace(/[\u0001\u0002]/g, ""));
}

function fnv32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // final avalanche
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0; h ^= h >>> 15;
  return h >>> 0;
}

/** 64-bit SimHash over word 3-grams of the first 1000 words. Hex, 16 characters. Empty for texts under 20 words. */
export function simhash(text: string): string {
  return simhashTokens(tokenize(text));
}

export function simhashTokens(all: string[]): string {
  const words = all.length > 1000 ? all.slice(0, 1000) : all;
  if (words.length < 20) return "";
  const v = new Int32Array(64);
  for (let i = 0; i + 2 < words.length; i++) {
    const g = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    const lo = fnv32(g, 0x811c9dc5);
    const hi = fnv32(g, 0x9747b28c);
    for (let b = 0; b < 32; b++) {
      v[b]! += (lo >>> b) & 1 ? 1 : -1;
      v[32 + b]! += (hi >>> b) & 1 ? 1 : -1;
    }
  }
  let lo = 0, hi = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b]! > 0) lo |= 1 << b;
    if (v[32 + b]! > 0) hi |= 1 << b;
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

const pop32 = (x: number): number => {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
};

export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  return pop32((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) + pop32((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0);
}

/** Damerau-Levenshtein style edit distance (adjacent transposition counts as 1), bounded: returns max+1 when over. */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const A = [...a], B = [...b];
  if (Math.abs(A.length - B.length) > max) return max + 1;
  const m = A.length, n = B.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n]!;
}
