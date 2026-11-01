"use client";

import * as React from "react";

/**
 * Client-side tab state for the browser chrome (visual skeleton, Phase 1).
 * Each tab has its own history list; "" is the new-tab page. Content routing (resolve, archive, frames) is Phase 2.
 */

export interface Tab {
  id: string;
  history: string[];
  index: number;
}

export const tabUrl = (t: Tab) => t.history[t.index] ?? "";
export function tabTitle(t: Tab): string {
  const u = tabUrl(t);
  if (!u) return "New tab";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`);
    return parsed.hostname || u;
  } catch {
    return u;
  }
}

interface BrowserState {
  tabs: Tab[];
  activeId: string;
  active: Tab;
  newTab: () => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  navigate: (input: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  /** Bumped by reload so content can re-render; Phase 2 re-resolves the address. */
  reloadCount: number;
}

const Ctx = React.createContext<BrowserState | null>(null);

export function useBrowser(): BrowserState {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useBrowser must be used inside BrowserProvider");
  return v;
}

let counter = 0;
const makeTab = (): Tab => ({ id: `tab-${++counter}`, history: [""], index: 0 });

export function BrowserProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = React.useState<Tab[]>(() => [makeTab()]);
  const [activeId, setActiveId] = React.useState(() => tabs[0]!.id);
  const [reloadCount, setReloadCount] = React.useState(0);

  const newTab = React.useCallback(() => {
    const t = makeTab();
    setTabs((l) => [...l, t]);
    setActiveId(t.id);
  }, []);

  const closeTab = React.useCallback(
    (id: string) => {
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
    },
    [],
  );

  const update = React.useCallback((fn: (t: Tab) => Tab) => {
    setTabs((l) => l.map((t) => (t.id === activeId ? fn(t) : t)));
  }, [activeId]);

  const navigate = React.useCallback(
    (input: string) => {
      const v = input.trim();
      update((t) => {
        if (v === tabUrl(t)) return t;
        const history = [...t.history.slice(0, t.index + 1), v];
        return { ...t, history, index: history.length - 1 };
      });
    },
    [update],
  );
  const back = React.useCallback(() => update((t) => (t.index > 0 ? { ...t, index: t.index - 1 } : t)), [update]);
  const forward = React.useCallback(
    () => update((t) => (t.index < t.history.length - 1 ? { ...t, index: t.index + 1 } : t)),
    [update],
  );
  const reload = React.useCallback(() => setReloadCount((n) => n + 1), []);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  const value = React.useMemo<BrowserState>(
    () => ({ tabs, activeId: active.id, active, newTab, closeTab, selectTab: setActiveId, navigate, back, forward, reload, reloadCount }),
    [tabs, active, newTab, closeTab, navigate, back, forward, reload, reloadCount],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
