"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, Settings2, Star, FolderHeart, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/layout/app-shell";
import { useEvents } from "@/components/layout/events";
import { useBrowser } from "@/components/browser/tabs";
import { useApi } from "@/lib/api";
import { useSearchPrefs } from "@/lib/search-prefs";
import { readHistory, searchHref } from "@/lib/search";
import type { Bookmark, Collection, CollectionItem, Dashboard, Page } from "@/lib/types";
import { SearchBox } from "./search-box";

const CONNECTION_TEXT = {
  online: "Online. Saved pages and the web are reachable.",
  offline: "Offline. Saved pages and local search still work.",
  unknown: "Connection not checked. Saved pages and local search work either way.",
} as const;

/** The minimalist search-engine homepage: the new-tab page of the browser. Optional sections are off until switched on in Search settings. */
export function SearchHome() {
  const router = useRouter();
  const ev = useEvents();
  const [q, setQ] = React.useState("");
  const [prefs] = useSearchPrefs();
  const go = (text: string) => {
    const t = text.trim();
    if (t) router.push(searchHref({ q: t }));
  };
  const any = prefs.homeRecent || prefs.homeBookmarks || prefs.homeCollections || prefs.homeStats;
  return (
    <div className="flex flex-1 flex-col items-center gap-8 px-4 pt-[12vh] pb-16" data-testid="search-home">
      <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">
        <Wordmark />
      </h1>
      <form
        role="search"
        aria-label="Search"
        className="flex w-full max-w-2xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
        }}
      >
        <SearchBox id="home-search" label="Search your archive and the web" value={q} onChange={setQ} onSubmit={go} size="lg" autoFocus />
        <Button type="submit" className="h-12 rounded-full px-6">
          Search
        </Button>
      </form>
      <p className="text-sm text-muted-foreground" data-testid="home-connection">
        {CONNECTION_TEXT[ev.connectivity]}
      </p>
      {any ? (
        <div className="grid w-full max-w-4xl gap-6 sm:grid-cols-2" data-testid="home-sections">
          {prefs.homeRecent ? <RecentSearches /> : null}
          {prefs.homeBookmarks ? <HomeBookmarks /> : null}
          {prefs.homeCollections ? <FavouriteCollections /> : null}
          {prefs.homeStats ? <LibraryStats /> : null}
        </div>
      ) : null}
      <Link href="/search?view=settings" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <Settings2 className="size-4" aria-hidden="true" /> Search settings
      </Link>
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" /> {title}
      </h2>
      {children}
    </section>
  );
}

const Quiet = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

function RecentSearches() {
  const hist = useApi<unknown>("/api/search/history?limit=6");
  const list = hist.data ? readHistory(hist.data) : null;
  return (
    <Section title="Recent searches" icon={Clock}>
      {!list ? <Quiet>{hist.error ? "Recent searches aren't available." : "Loading…"}</Quiet> : !list.enabled ? <Quiet>Search history is off.</Quiet> : list.items.length === 0 ? <Quiet>No searches yet.</Quiet> : (
        <ul className="space-y-1">
          {list.items.slice(0, 6).map((h) => (
            <li key={h.id} className="truncate">
              <Link href={searchHref({ q: h.query })} className="text-sm text-primary underline-offset-4 hover:underline">{h.query}</Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function HomeBookmarks() {
  const b = useBrowser();
  const bm = useApi<{ items: Bookmark[] }>("/api/bookmarks");
  const items = bm.data?.items.slice(0, 6) ?? [];
  return (
    <Section title="Bookmarks" icon={Star}>
      {!bm.data ? <Quiet>{bm.error ? "Bookmarks aren't available." : "Loading…"}</Quiet> : items.length === 0 ? <Quiet>No bookmarks yet.</Quiet> : (
        <ul className="space-y-1">
          {items.map((x) => (
            <li key={x.id} className="truncate">
              <button type="button" className="max-w-full truncate text-left text-sm text-primary underline-offset-4 hover:underline" onClick={() => b.openInBrowser(x.originalUrl)}>
                {x.title || x.originalUrl}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function FavouriteCollections() {
  const b = useBrowser();
  const cols = useApi<{ items: Collection[] }>("/api/collections");
  const fav = cols.data?.items.find((c) => c.kind === "favourites");
  const items = useApi<Page<CollectionItem>>(fav ? `/api/collections/${fav.id}/items?limit=6` : null);
  return (
    <Section title="Favourites" icon={FolderHeart}>
      {!cols.data ? <Quiet>{cols.error ? "Favourites aren't available." : "Loading…"}</Quiet> : !fav || (items.data && items.data.items.length === 0) ? <Quiet>Nothing in Favourites yet.</Quiet> : (
        <ul className="space-y-1">
          {(items.data?.items ?? []).map((x) => (
            <li key={x.pageId} className="truncate">
              <button type="button" className="max-w-full truncate text-left text-sm text-primary underline-offset-4 hover:underline" onClick={() => b.openInBrowser(x.url)}>
                {x.title || x.url}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function LibraryStats() {
  const d = useApi<Dashboard>("/api/system/dashboard");
  return (
    <Section title="Your library" icon={BarChart3}>
      {!d.data ? <Quiet>{d.error ? "Library figures aren't available." : "Loading…"}</Quiet> : (
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div><dt className="text-muted-foreground">Saved pages</dt><dd className="text-lg font-medium">{d.data.pages.archived}</dd></div>
          <div><dt className="text-muted-foreground">Sources</dt><dd className="text-lg font-medium">{d.data.sources.total}</dd></div>
          <div><dt className="text-muted-foreground">Collections</dt><dd className="text-lg font-medium">{d.data.collections}</dd></div>
        </dl>
      )}
    </Section>
  );
}
