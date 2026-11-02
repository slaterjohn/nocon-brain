// Back-navigation restore for the results page. A search that was run is remembered for the tab (sessionStorage) as
// `{ searchId, scrollY }`. When the Human comes back with Back or Forward, the list is rebuilt from the server's snapshot
// (GET /api/search/{id}, kept 30 minutes) instead of searching again, so it is the same list in the same order.

const KEY = "ncb.search.restore:";
const MAX_AGE_MS = 25 * 60 * 1000;

let poppedAt = 0;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    poppedAt = Date.now();
  });
}

export interface RestoreRecord {
  searchId: string;
  at: number;
  scrollY: number;
}

/** True right after Back or Forward, once: the page was opened by history traversal, in the app or as a fresh page load. */
export function consumeHistoryTraversal(): boolean {
  if (typeof window === "undefined") return false;
  if (Date.now() - poppedAt < 3000) {
    poppedAt = 0;
    return true;
  }
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    // A page load by Back/Forward, in the first seconds of the page's life only.
    if (nav?.type === "back_forward" && performance.now() < 5000) return true;
  } catch {
    /* not available */
  }
  return false;
}

export function saveRestore(stateKey: string, rec: Omit<RestoreRecord, "at">): void {
  try {
    sessionStorage.setItem(KEY + stateKey, JSON.stringify({ ...rec, at: Date.now() }));
  } catch {
    /* storage blocked: the page searches again */
  }
}

export function readRestore(stateKey: string, now = Date.now()): RestoreRecord | null {
  try {
    const raw = sessionStorage.getItem(KEY + stateKey);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<RestoreRecord>;
    if (typeof r.searchId !== "string" || typeof r.at !== "number" || now - r.at > MAX_AGE_MS) return null;
    return { searchId: r.searchId, at: r.at, scrollY: typeof r.scrollY === "number" ? r.scrollY : 0 };
  } catch {
    return null;
  }
}

export function updateScroll(stateKey: string, scrollY: number): void {
  const r = readRestore(stateKey);
  if (r) saveRestore(stateKey, { searchId: r.searchId, scrollY });
}
