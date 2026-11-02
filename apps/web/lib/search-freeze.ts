// When the list may change on its own (docs/api.md 6.1 merging contract, plan task O-06).
//
// The list is open until the Human interacts: scrolls, moves focus into the results, rests the pointer on a result for more than
// 300 ms, or types in the filters. From then on nothing changes by itself. The 2 s time box also closes the list to late events.
// This file is the pure part; the browser wiring is in components/search/use-freeze.ts.

export const HOVER_FREEZE_MS = 300;
/** Online results arriving later than this after the search started wait behind "Load more from the web". */
export const TIME_BOX_MS = 2000;

export type Interaction = "scroll" | "focus" | "hover" | "filter_typing" | "keyboard_scroll";

export interface FreezeState {
  frozen: boolean;
  /** What froze it first, for tests and for the status text. */
  reason?: Interaction;
}

export const OPEN: FreezeState = { frozen: false };

/** Hover freezes only when it lasts long enough; the other interactions freeze at once. */
export function freezes(kind: Interaction, hoverMs = 0): boolean {
  return kind === "hover" ? hoverMs > HOVER_FREEZE_MS : true;
}

export function freeze(s: FreezeState, kind: Interaction, hoverMs = 0): FreezeState {
  if (s.frozen || !freezes(kind, hoverMs)) return s;
  return { frozen: true, reason: kind };
}

/** True when keys such as PageDown or the space bar scroll the page. */
export function isScrollKey(key: string): boolean {
  return ["PageDown", "PageUp", "End", "Home", "ArrowDown", "ArrowUp", " ", "Spacebar"].includes(key);
}

/**
 * Whether events that change the list apply now (`false`) or wait (`true`).
 * `elapsedMs` is the time since the search started.
 */
export function shouldHold(s: FreezeState, elapsedMs: number, timeBoxMs = TIME_BOX_MS): boolean {
  return s.frozen || elapsedMs > timeBoxMs;
}

/** What the status line says about waiting results. */
export type HoldCause = "frozen" | "time_box" | null;
export function holdCause(s: FreezeState, elapsedMs: number): HoldCause {
  if (s.frozen) return "frozen";
  return elapsedMs > TIME_BOX_MS ? "time_box" : null;
}
