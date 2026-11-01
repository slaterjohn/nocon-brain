/**
 * Find-in-page matching (task A-18, decision D-6). One tokeniser is shared by the listener's `?hl=` highlighting and the
 * `/api/archive/versions/{id}/find` count, so the number the find bar shows is the number of `<mark>` elements in the frame.
 *
 * Matching is case-insensitive within one text node. A match never spans two elements, and runs of whitespace in the
 * search text count as one space. Folding keeps the string length, so offsets in the folded text are offsets in the original.
 */

export const MAX_HITS = 500;
export const MAX_TERM_LENGTH = 100;
export const HIT_ID_PREFIX = "ncb-hit-";

/** The search text as it is matched: trimmed, whitespace collapsed, capped. Null when nothing is left to search for. */
export function normaliseTerm(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TERM_LENGTH);
  return t.length > 0 ? t : null;
}

/** Lower-cases per UTF-16 unit and turns every whitespace unit into a plain space, so the length never changes. */
export function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    // A character whose lower-case form has a different length (for example U+0130) keeps its original form.
    const f = lower.length === ch.length ? lower : ch;
    out += /\s/.test(ch) ? " ".repeat(ch.length) : f;
  }
  return out;
}

/** Start offsets of non-overlapping matches of `term` in `text`, left to right. */
export function matchOffsets(text: string, term: string, limit = MAX_HITS): number[] {
  const needle = fold(term);
  if (!needle) return [];
  const hay = fold(text);
  const out: number[] = [];
  let from = 0;
  while (out.length < limit) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + needle.length;
  }
  return out;
}

/** Injected into `<head>` with `?hl=`: every hit is marked, and the hit the fragment points at is stronger (`:target`, no script needed). */
export const HIGHLIGHT_CSS =
  "mark.ncb-hit{background:#ffe066;color:#111;border-radius:2px;padding:0 1px}" +
  "mark.ncb-hit:target{background:#ff9f1c;outline:2px solid #1d3557;outline-offset:1px}";
