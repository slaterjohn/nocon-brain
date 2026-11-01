"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, get, post } from "@/lib/api";
import type { FrameInfo, FrameStateInfo, LinkStateName, PageSummary, ResolveResponse, SaveResponse, VersionSummary } from "@/lib/types";
import { useEvents } from "@/components/layout/events";

/**
 * Client-side tabs for the browser area (A-14).
 *
 * Each tab keeps its own history stack (shell-managed back and forward). Opening an address asks the server to `resolve` it
 * (archive, live or offline page) and, for an archived page, shows it in a sandboxed iframe. The iframe cannot report its own
 * address, so after every `load` event the shell reads the listener's record of the last document it served to that frame
 * (`GET /api/browser/frame-state`, decision D-5) and updates the address bar, title and link state. In-frame clicks and the
 * browser's own Back button are seen the same way. Shell-initiated moves (Back and Forward buttons, reload, a new address)
 * re-resolve and re-create the iframe, so they add nothing to the browser's joint session history.
 */

export type ViewMode = "archived" | "reader" | "original";

export interface Entry {
  /** The address as shown in the address bar. */
  url: string;
  title?: string;
  mode: ViewMode;
  pageId?: string;
}

/** What the frame is showing right now (it can differ from the entry after an in-frame click). */
export interface Current {
  url: string;
  title: string;
  state: LinkStateName | "zim";
  pageId?: string;
  versionId?: string;
  reader: boolean;
  interstitial: boolean;
}

export type Content =
  | { kind: "blank" }
  | { kind: "loading"; url: string }
  | { kind: "error"; url: string; message: string }
  | { kind: "archive"; frame: FrameInfo; page: PageSummary; version: VersionSummary; alternatives: ResolveResponse["alternatives"]; current: Current; frameKey: number }
  | { kind: "live"; url: string; alternatives: ResolveResponse["alternatives"]; queued?: { downloadId: string } }
  | { kind: "offline"; url: string; reason: "offline" | "forced_offline" | "blocked" | "not_archived"; canQueue: boolean; queued?: { downloadId: string } };

export interface Tab {
  id: string;
  history: Entry[];
  index: number;
  content: Content;
  /** `seq` of the last frame-state this tab has applied. */
  lastSeq: number;
  /** A save started from this tab. */
  saving?: { downloadId: string; url: string };
}

export const entryOf = (t: Tab): Entry | undefined => t.history[t.index];
export const tabUrl = (t: Tab) => entryOf(t)?.url ?? "";

export function hostOf(u: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).hostname || u;
  } catch {
    return u;
  }
}

export function tabTitle(t: Tab): string {
  const c = t.content;
  if (c.kind === "archive" && c.current.title) return c.current.title;
  const e = entryOf(t);
  if (!e?.url) return "New tab";
  return e.title || hostOf(e.url);
}

/** Where the page in this tab came from, for the indicator next to the address bar and on the tab. */
export type Source = "blank" | "loading" | "saved" | "partial" | "reader" | "live" | "offline" | "unsaved" | "error";
export function tabSource(t: Tab): Source {
  const c = t.content;
  switch (c.kind) {
    case "blank": return "blank";
    case "loading": return "loading";
    case "error": return "error";
    case "live": return "live";
    case "offline": return "offline";
    case "archive":
      if (c.current.interstitial) return "unsaved";
      return c.current.reader ? "reader" : c.current.state === "partial" ? "partial" : "saved";
  }
}

const modeToPrefer = (m: ViewMode) => (m === "reader" ? "reader" : m === "original" ? "live" : "archive");

interface BrowserState {
  tabs: Tab[];
  activeId: string;
  active: Tab;
  newTab: () => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  navigate: (input: string, opts?: { mode?: ViewMode }) => Promise<void>;
  /** Opens an address from anywhere in the app: goes to the Browser area, then navigates the active tab. */
  openInBrowser: (url: string, opts?: { newTab?: boolean; mode?: ViewMode }) => void;
  setMode: (mode: ViewMode) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  onFrameLoad: (tabId: string, frameKey: number) => void;
  /** Starts a capture of the active tab's address. */
  save: (opts?: { queue?: boolean }) => Promise<void>;
  /** Re-opens the active address (after a save finished, for example). */
  reopen: () => void;
  /** The element that should take focus after the active tab changed (WCAG 2.4.3). */
  focusRequest: number;
}

const Ctx = React.createContext<BrowserState | null>(null);

export function useBrowser(): BrowserState {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useBrowser must be used inside BrowserProvider");
  return v;
}

let counter = 0;
const makeTab = (): Tab => ({ id: `tab-${++counter}`, history: [{ url: "", mode: "archived" }], index: 0, content: { kind: "blank" }, lastSeq: 0 });

export function BrowserProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { trackCapture } = useEvents();
  const [tabs, setTabs] = React.useState<Tab[]>(() => [makeTab()]);
  const [activeId, setActiveId] = React.useState(() => tabs[0]!.id);
  const [focusRequest, setFocusRequest] = React.useState(0);
  const tabsRef = React.useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = React.useRef(activeId);
  activeRef.current = activeId;
  const seq = React.useRef<Record<string, number>>({});
  const frameKeys = React.useRef(0);

  const patch = React.useCallback((id: string, fn: (t: Tab) => Tab) => {
    setTabs((l) => l.map((t) => (t.id === id ? fn(t) : t)));
  }, []);

  /** Resolves `input` for a tab. `push` adds a history entry (a typed address); otherwise the entry at `index` is reloaded. */
  const run = React.useCallback(
    async (tabId: string, input: string, opts: { push: boolean; mode: ViewMode; versionId?: string }) => {
      const my = (seq.current[tabId] = (seq.current[tabId] ?? 0) + 1);
      const previous: Content = tabsRef.current.find((t) => t.id === tabId)?.content ?? { kind: "blank" };
      patch(tabId, (t) => ({ ...t, content: { kind: "loading", url: input } }));
      let res: ResolveResponse;
      try {
        res = await post<ResolveResponse>("/api/browser/resolve", { input, tabId, prefer: modeToPrefer(opts.mode), versionId: opts.versionId });
      } catch (e) {
        if (seq.current[tabId] !== my) return;
        patch(tabId, (t) => ({ ...t, content: { kind: "error", url: input, message: errorMessage(e) } }));
        return;
      }
      if (seq.current[tabId] !== my) return;
      const r = res.resolution;
      if (r.kind === "search") {
        // Search arrives in a later release; the results page says so. The tab goes back to what it showed.
        patch(tabId, (t) => ({ ...t, content: previous }));
        router.push(`/search?q=${encodeURIComponent(r.query)}`);
        return;
      }
      // A redirect or alias shows where the page really is, as a browser does after a redirect.
      const address = r.kind === "archive" ? r.page.url : res.normalizedUrl;
      const entryPatch: Partial<Entry> = { url: address, mode: opts.mode, ...(r.kind === "archive" ? { pageId: r.page.id, title: r.page.title } : { pageId: undefined }) };
      const content: Content =
        r.kind === "archive"
          ? {
              kind: "archive", frame: r.frame, page: r.page, version: r.version, alternatives: res.alternatives, frameKey: ++frameKeys.current,
              current: { url: r.page.url, title: r.page.title, state: r.version.status === "partial" ? "partial" : "cached", pageId: r.page.id, versionId: r.version.id, reader: r.mode === "reader", interstitial: false },
            }
          : r.kind === "live"
            ? { kind: "live", url: r.url, alternatives: res.alternatives, queued: r.queued }
            : { kind: "offline", url: r.url, reason: r.reason, canQueue: r.canQueue, queued: r.queued };
      patch(tabId, (t) => {
        let history = t.history;
        let index = t.index;
        if (opts.push && t.history[t.index]?.url !== address) {
          history = [...t.history.slice(0, t.index + 1), { url: address, mode: opts.mode, ...entryPatch } as Entry];
          index = history.length - 1;
        } else {
          // Reload, a different view of the same address, or the same address typed again: the entry is updated in place.
          history = t.history.map((e, i) => (i === t.index ? { ...e, ...entryPatch } : e));
        }
        return { ...t, history, index, content, lastSeq: 0, saving: t.saving };
      });
    },
    [patch, router],
  );

  const navigate = React.useCallback(
    async (input: string, opts: { mode?: ViewMode } = {}) => {
      const v = input.trim();
      if (!v) return;
      await run(activeRef.current, v, { push: true, mode: opts.mode ?? "archived" });
    },
    [run],
  );

  const openInBrowser = React.useCallback(
    (url: string, opts: { newTab?: boolean; mode?: ViewMode } = {}) => {
      let id = activeRef.current;
      if (opts.newTab) {
        const t = makeTab();
        setTabs((l) => [...l, t]);
        setActiveId(t.id);
        activeRef.current = t.id;
        id = t.id;
      }
      router.push("/");
      void run(id, url, { push: true, mode: opts.mode ?? "archived" });
    },
    [router, run],
  );

  const newTab = React.useCallback(() => {
    const t = makeTab();
    setTabs((l) => [...l, t]);
    setActiveId(t.id);
    setFocusRequest((n) => n + 1);
  }, []);

  const closeTab = React.useCallback((id: string) => {
    setTabs((l) => {
      const i = l.findIndex((t) => t.id === id);
      if (i < 0) return l;
      if (l.length === 1) {
        // Closing the last tab leaves a fresh new tab, like a browser that stays open.
        const t = makeTab();
        setActiveId(t.id);
        return [t];
      }
      const next = l.filter((t) => t.id !== id);
      setActiveId((cur) => (cur === id ? next[Math.min(i, next.length - 1)]!.id : cur));
      return next;
    });
    setFocusRequest((n) => n + 1);
  }, []);

  const selectTab = React.useCallback((id: string) => {
    setActiveId(id);
    setFocusRequest((n) => n + 1);
  }, []);

  const move = React.useCallback(
    (delta: -1 | 1) => {
      const t = tabsRef.current.find((x) => x.id === activeRef.current);
      if (!t) return;
      const idx = t.index + delta;
      const e = t.history[idx];
      if (!e) return;
      patch(t.id, (x) => ({ ...x, index: idx }));
      if (!e.url) {
        patch(t.id, (x) => ({ ...x, index: idx, content: { kind: "blank" } }));
        return;
      }
      void run(t.id, e.url, { push: false, mode: e.mode });
    },
    [patch, run],
  );
  const back = React.useCallback(() => move(-1), [move]);
  const forward = React.useCallback(() => move(1), [move]);

  const reload = React.useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeRef.current);
    const e = t && entryOf(t);
    if (!t || !e?.url) return;
    void run(t.id, e.url, { push: false, mode: e.mode });
  }, [run]);

  const reopen = reload;

  const setMode = React.useCallback(
    (mode: ViewMode) => {
      const t = tabsRef.current.find((x) => x.id === activeRef.current);
      const e = t && entryOf(t);
      if (!t || !e?.url) return;
      // A different view of the same address replaces the entry rather than adding one.
      void run(t.id, e.url, { push: false, mode });
    },
    [run],
  );

  /** D-5: read what the listener last served to this tab's frame, and follow it. */
  const onFrameLoad = React.useCallback(
    (tabId: string, frameKey: number) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.content.kind !== "archive" || tab.content.frameKey !== frameKey) return;
      const frameId = tab.content.frame.frameId;
      get<FrameStateInfo>(`/api/browser/frame-state?frameId=${encodeURIComponent(frameId)}`)
        .then((fs) => {
          setTabs((list) =>
            list.map((t) => {
              if (t.id !== tabId || t.content.kind !== "archive" || t.content.frameKey !== frameKey) return t;
              if (fs.seq <= t.lastSeq) return t; // nothing new: a highlight reload or a fragment move
              const c = t.content;
              const current: Current = {
                url: fs.url, title: fs.title || fs.url, state: fs.state, pageId: fs.pageId, versionId: fs.versionId,
                reader: !!fs.reader, interstitial: !!fs.interstitial,
              };
              const cur = t.history[t.index]!;
              const sameDoc = (e: Entry | undefined) => !!e && (current.pageId ? e.pageId === current.pageId : e.url === current.url);
              let { history, index } = t;
              if (sameDoc(cur)) {
                history = history.map((e, i) => (i === index ? { ...e, title: current.title, pageId: current.pageId ?? e.pageId } : e));
              } else if (sameDoc(history[index - 1])) {
                index -= 1; // the browser's own Back, inside the frame
                history = history.map((e, i) => (i === index ? { ...e, title: current.title } : e));
              } else if (sameDoc(history[index + 1])) {
                index += 1; // the browser's own Forward
                history = history.map((e, i) => (i === index ? { ...e, title: current.title } : e));
              } else {
                // A click inside the frame: a new entry, with no new frame.
                const entry: Entry = { url: current.url, title: current.title, mode: current.reader ? "reader" : "archived", pageId: current.pageId };
                history = [...history.slice(0, index + 1), entry];
                index = history.length - 1;
              }
              return { ...t, history, index, lastSeq: fs.seq, content: { ...c, current } };
            }),
          );
        })
        .catch(() => undefined);
    },
    [],
  );

  const save = React.useCallback(
    async (opts: { queue?: boolean } = {}) => {
      const t = tabsRef.current.find((x) => x.id === activeRef.current);
      if (!t) return;
      const c = t.content;
      const url = c.kind === "live" || c.kind === "offline" ? c.url : c.kind === "archive" ? c.current.url : undefined;
      if (!url) return;
      const res = await api<SaveResponse>("/api/browser/save", { method: "POST", body: { url, queue: opts.queue } });
      trackCapture({ downloadId: res.downloadId, url: res.url, state: "queued", held: res.held, outcome: "pending", label: res.held ? "Waiting for the connection to return" : "Waiting to start", percent: 0 });
      patch(t.id, (x) => ({ ...x, saving: { downloadId: res.downloadId, url: res.url } }));
    },
    [patch, trackCapture],
  );

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  const value = React.useMemo<BrowserState>(
    () => ({ tabs, activeId: active.id, active, newTab, closeTab, selectTab, navigate, openInBrowser, setMode, back, forward, reload, onFrameLoad, save, reopen, focusRequest }),
    [tabs, active, newTab, closeTab, selectTab, navigate, openInBrowser, setMode, back, forward, reload, onFrameLoad, save, reopen, focusRequest],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
