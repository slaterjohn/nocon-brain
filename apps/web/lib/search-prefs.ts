"use client";

import * as React from "react";
import { api, ApiError, get, patch, useApi } from "@/lib/api";

// Search preferences live in the signed-in user's server settings (GET and PATCH /api/settings/user, key `search`). A guest has no
// settings, so the defaults apply and a change lasts until the page is closed.

export interface SearchPrefs {
  resultsPerPage: number;
  homeRecent: boolean;
  homeBookmarks: boolean;
  homeCollections: boolean;
  homeStats: boolean;
}

export const DEFAULT_PREFS: SearchPrefs = { resultsPerPage: 10, homeRecent: false, homeBookmarks: false, homeCollections: false, homeStats: false };

interface UserSearchSettings {
  search?: { homepageSections?: { recentSearches?: boolean; bookmarks?: boolean; favourites?: boolean; libraryStats?: boolean }; resultsPerPage?: number };
}

function fromServer(u: UserSearchSettings): SearchPrefs {
  const h = u.search?.homepageSections ?? {};
  const n = u.search?.resultsPerPage;
  return {
    resultsPerPage: typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_PREFS.resultsPerPage,
    homeRecent: h.recentSearches === true,
    homeBookmarks: h.bookmarks === true,
    homeCollections: h.favourites === true,
    homeStats: h.libraryStats === true,
  };
}

function toServer(p: Partial<SearchPrefs>): UserSearchSettings {
  const sections: NonNullable<NonNullable<UserSearchSettings["search"]>["homepageSections"]> = {};
  if (p.homeRecent !== undefined) sections.recentSearches = p.homeRecent;
  if (p.homeBookmarks !== undefined) sections.bookmarks = p.homeBookmarks;
  if (p.homeCollections !== undefined) sections.favourites = p.homeCollections;
  if (p.homeStats !== undefined) sections.libraryStats = p.homeStats;
  const search: NonNullable<UserSearchSettings["search"]> = {};
  if (Object.keys(sections).length) search.homepageSections = sections;
  if (p.resultsPerPage !== undefined) search.resultsPerPage = p.resultsPerPage;
  return { search };
}

// One copy shared by every component on the page.
let current: SearchPrefs = DEFAULT_PREFS;
let ready = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const isGuest = (err: unknown) => err instanceof ApiError && (err.status === 401 || err.status === 403);

function load(): Promise<void> {
  inflight ??= api<UserSearchSettings>("/api/settings/user", { noRedirect: true })
    .then((u) => {
      current = fromServer(u);
    })
    .catch(() => {
      /* a guest, or the server is unreachable: the defaults stand */
    })
    .finally(() => {
      ready = true;
      emit();
    });
  return inflight;
}

/** The prefs, a function that saves a change, and whether the saved values have been read yet. */
export function useSearchPrefs(): [SearchPrefs, (patch: Partial<SearchPrefs>) => Promise<void>, boolean] {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    listeners.add(force);
    void load();
    return () => {
      listeners.delete(force);
    };
  }, []);
  const update = React.useCallback(async (p: Partial<SearchPrefs>) => {
    const before = current;
    current = { ...current, ...p };
    emit();
    try {
      await api("/api/settings/user", { method: "PATCH", body: toServer(p), noRedirect: true });
    } catch (err) {
      // A guest cannot save: the choice stands for this visit. Any other failure puts back only the values this change touched.
      if (isGuest(err)) return;
      const back: Partial<SearchPrefs> = {};
      for (const k of Object.keys(p) as (keyof SearchPrefs)[]) (back as Record<string, unknown>)[k] = before[k];
      current = { ...current, ...back };
      emit();
      throw err;
    }
  }, []);
  return [current, update, ready];
}

export interface SearchServerSettings {
  privacy?: { searchHistory?: { enabled?: boolean }; onlineSearch?: { enabled?: boolean } };
  browser?: { preferCached?: boolean };
}

/** The server settings the Search area shows: the history switch and the cached or live preference. */
export function useSearchServerSettings() {
  const settings = useApi<SearchServerSettings>("/api/settings");
  const [saving, setSaving] = React.useState(false);
  const save = React.useCallback(
    async (body: SearchServerSettings) => {
      setSaving(true);
      try {
        const res = await patch<SearchServerSettings>("/api/settings", body);
        settings.setData({ ...settings.data, ...res });
        return res;
      } finally {
        setSaving(false);
      }
    },
    [settings],
  );
  return { settings, save, saving };
}

/** Whether online search can be used: switched on in settings and at least one provider enabled. Always false until providers exist. */
export function useOnlineAvailable(): boolean {
  const [available, setAvailable] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    Promise.all([get<SearchServerSettings>("/api/settings"), get<unknown>("/api/search/providers")])
      .then(([s, p]) => {
        const o = p as { items?: { enabled?: boolean }[] } | { enabled?: boolean }[];
        const list = Array.isArray(o) ? o : (o.items ?? []);
        if (live) setAvailable(s.privacy?.onlineSearch?.enabled === true && list.some((x) => x.enabled !== false));
      })
      .catch(() => live && setAvailable(false));
    return () => {
      live = false;
    };
  }, []);
  return available;
}
