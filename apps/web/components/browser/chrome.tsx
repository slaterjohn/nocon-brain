"use client";

import * as React from "react";
import Link from "next/link";
import {
  Archive, ArrowLeft, ArrowRight, BookOpen, Bookmark as BookmarkIcon, CircleHelp, ExternalLink, Globe, History, Loader2, Plus, RotateCw, Save, Search,
  Star, WifiOff, X, AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { del, errorMessage, get, post, useApi } from "@/lib/api";
import type { Bookmark } from "@/lib/types";
import { matchShortcut } from "@/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { useEvents } from "@/components/layout/events";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { entryOf, tabSource, tabTitle, tabUrl, useBrowser, type Source, type Tab, type ViewMode } from "./tabs";

const SINGLE_KEYS = "ncb.singleKeys";

/** The address the bookmark and save buttons act on: the page in the frame, or the tab's address. */
export function pageAddress(t: Tab): string {
  const c = t.content;
  if (c.kind === "archive" && !c.current.interstitial) return c.current.url;
  if (c.kind === "archive") return c.current.url;
  if (c.kind === "live" || c.kind === "offline") return c.url;
  return tabUrl(t);
}

const SOURCE_TEXT: Record<Source, { label: string; hint: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }> }> = {
  blank: { label: "No page", hint: "", icon: Globe },
  loading: { label: "Opening", hint: "Looking for this page.", icon: Loader2 },
  saved: { label: "Saved copy", hint: "This is the copy saved on this server. It opens without internet.", icon: Archive },
  partial: { label: "Partly saved copy", hint: "This copy is missing some files.", icon: Archive },
  reader: { label: "Reader view", hint: "The saved copy, shown as plain text for reading.", icon: BookOpen },
  live: { label: "Not saved", hint: "This address is not saved. Open the live site, or save it for offline.", icon: Globe },
  offline: { label: "Offline, not saved", hint: "There is no internet and this page is not saved.", icon: WifiOff },
  unsaved: { label: "Not saved", hint: "A link in a saved page that leads to something that is not saved.", icon: Globe },
  error: { label: "Could not open", hint: "", icon: AlertTriangle },
};

/** Where this tab's page came from. Text and icon, never colour alone. */
export function SourceBadge({ tab, className }: { tab: Tab; className?: string }) {
  const { connectivity } = useEvents();
  const source = tabSource(tab);
  if (source === "blank") return null;
  // A live tab turns into an "offline" one the moment the connection is lost.
  const eff: Source = source === "live" && connectivity === "offline" ? "offline" : source;
  const { label, hint, icon: Icon } = SOURCE_TEXT[eff];
  return (
    <span
      data-testid="tab-source"
      data-source={eff}
      title={hint || undefined}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs", eff === "offline" || eff === "error" ? "border-warning text-warning" : "text-muted-foreground", className)}
    >
      <Icon className={cn("size-3", eff === "loading" && "animate-spin")} aria-hidden="true" />
      {label}
    </span>
  );
}

function useBookmarkState(address: string) {
  const { toast } = useToast();
  const [bookmark, setBookmark] = React.useState<Bookmark | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    setBookmark(null);
    if (!/^https?:\/\//i.test(address)) return;
    let live = true;
    get<{ items: Bookmark[] }>(`/api/bookmarks?url=${encodeURIComponent(address)}`)
      .then((r) => live && setBookmark(r.items[0] ?? null))
      .catch(() => undefined);
    return () => { live = false; };
  }, [address]);
  const toggle = React.useCallback(async () => {
    if (!/^https?:\/\//i.test(address) || busy) return;
    setBusy(true);
    try {
      if (bookmark) {
        await del(`/api/bookmarks/${bookmark.id}`);
        setBookmark(null);
        toast({ title: "Bookmark removed" });
      } else {
        const b = await post<Bookmark>("/api/bookmarks", { url: address });
        setBookmark(b);
        toast({ title: "Bookmarked", description: b.archive ? "The saved copy is linked to the bookmark." : "This page is not saved yet. Use Save for offline to keep a copy." });
      }
    } catch (e) {
      toast({ title: "Couldn't change the bookmark", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }, [address, bookmark, busy, toast]);
  return { bookmark, toggle, busy };
}

function BookmarksMenu() {
  const b = useBrowser();
  const [open, setOpen] = React.useState(false);
  const list = useApi<{ items: Bookmark[] }>("/api/bookmarks", { enabled: open });
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Bookmarks and history" data-testid="bookmarks-menu">
          <BookmarkIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Bookmarks</DropdownMenuLabel>
        {list.data && list.data.items.length === 0 ? <p className="px-2 py-1.5 text-sm text-muted-foreground">No bookmarks yet.</p> : null}
        {list.data?.items.slice(0, 15).map((bm) => (
          <DropdownMenuItem key={bm.id} onSelect={() => b.openInBrowser(bm.originalUrl)} className="flex-col items-start gap-0">
            <span className="w-full truncate text-sm">{bm.title}</span>
            <span className="w-full truncate text-xs text-muted-foreground">{bm.archive ? "Saved copy" : "Not saved"} · {bm.originalUrl}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/bookmarks"><BookmarkIcon aria-hidden="true" /> All bookmarks</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/history"><History aria-hidden="true" /> History</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const MODES: { mode: ViewMode; label: string; need: "archive" | "reader" | "live" }[] = [
  { mode: "archived", label: "Saved", need: "archive" },
  { mode: "reader", label: "Reader", need: "reader" },
  { mode: "original", label: "Original", need: "live" },
];

/**
 * Browser chrome: tab strip, back/forward/reload, address bar, view switch, bookmark, save and find.
 * Shortcuts are in lib/shortcuts.ts and listed in the help dialog.
 */
export function BrowserChrome({
  addressRef, onToggleFind, findOpen,
}: { addressRef: React.RefObject<HTMLInputElement | null>; onToggleFind: () => void; findOpen: boolean }) {
  const b = useBrowser();
  const ev = useEvents();
  const { toast } = useToast();
  const active = b.active;
  const url = tabUrl(active);
  const [text, setText] = React.useState(url);
  const [help, setHelpOpen] = React.useState(false);
  const helpOpener = React.useRef<HTMLElement | null>(null);
  const setHelp = React.useCallback((open: boolean) => {
    if (open) helpOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHelpOpen(open);
  }, []);
  const [singleKeys, setSingleKeys] = React.useState(true);
  const tabRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  React.useEffect(() => {
    try {
      setSingleKeys(localStorage.getItem(SINGLE_KEYS) !== "0");
    } catch {
      /* storage can be blocked: keep the default */
    }
  }, []);
  const setSingle = (on: boolean) => {
    setSingleKeys(on);
    try {
      localStorage.setItem(SINGLE_KEYS, on ? "1" : "0");
    } catch {
      /* not persisted */
    }
  };

  // The address bar follows the active tab and its history position (and so, through frame state, the frame).
  React.useEffect(() => setText(url), [url, active.id]);

  const focusAddress = React.useCallback(() => {
    addressRef.current?.focus();
    addressRef.current?.select();
  }, [addressRef]);

  // Focus management (WCAG 2.4.3): a new tab starts in its address bar; after closing or switching, focus stays on the tab strip.
  const lastFocus = React.useRef(b.focusRequest);
  React.useEffect(() => {
    if (b.focusRequest === lastFocus.current) return;
    lastFocus.current = b.focusRequest;
    const id = requestAnimationFrame(() => {
      if (active.content.kind === "blank" && !url) focusAddress();
      else tabRefs.current[active.id]?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [b.focusRequest, active.id, active.content.kind, url, focusAddress]);

  const address = pageAddress(active);
  const star = useBookmarkState(address);
  const content = active.content;
  const canSave = content.kind === "live" || content.kind === "offline" || (content.kind === "archive" && content.current.interstitial);
  const mode: ViewMode = content.kind === "archive" ? (content.current.reader ? "reader" : "archived") : content.kind === "live" ? "original" : (entryOf(active)?.mode ?? "archived");
  const alternatives = content.kind === "archive" || content.kind === "live" ? content.alternatives : [];
  const liveHref = content.kind === "live" || content.kind === "offline" ? content.url : address;
  const openLive = React.useCallback(() => {
    if (/^https?:\/\//i.test(liveHref) && ev.connectivity !== "offline") window.open(liveHref, "_blank", "noopener,noreferrer");
  }, [liveHref, ev.connectivity]);

  const saveNow = React.useCallback(() => {
    b.save({ queue: ev.connectivity === "offline" }).catch((e) => toast({ title: "Couldn't start the save", description: errorMessage(e), variant: "error" }));
  }, [b, ev.connectivity, toast]);

  const stateRef = React.useRef({ b, ev, star, saveNow, openLive, canSave, mode, onToggleFind });
  stateRef.current = { b, ev, star, saveNow, openLive, canSave, mode, onToggleFind };

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const m = matchShortcut(e, singleKeys);
      if (!m) return;
      const s = stateRef.current;
      e.preventDefault();
      switch (m.id) {
        case "newTab": s.b.newTab(); break;
        case "closeTab": s.b.closeTab(s.b.activeId); break;
        case "tab1": { const t = s.b.tabs[(m.tab ?? 1) - 1]; if (t) s.b.selectTab(t.id); break; }
        case "focusAddress": focusAddress(); break;
        case "back": s.b.back(); break;
        case "forward": s.b.forward(); break;
        case "reload": s.b.reload(); break;
        case "bookmark": void s.star.toggle(); break;
        case "save": if (s.canSave) s.saveNow(); break;
        case "reader": s.b.setMode(s.mode === "reader" ? "archived" : "reader"); break;
        case "openLive": s.openLive(); break;
        case "find": s.onToggleFind(); break;
        case "workOffline": void s.ev.setForceOffline(!s.ev.forced).catch(() => undefined); break;
        case "help": setHelp(true); break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [singleKeys, focusAddress, setHelp]);

  const canBack = active.index > 0;
  const canForward = active.index < active.history.length - 1;

  function onTabKey(e: React.KeyboardEvent, i: number) {
    const n = b.tabs.length;
    let to = -1;
    if (e.key === "ArrowRight") to = (i + 1) % n;
    else if (e.key === "ArrowLeft") to = (i - 1 + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    else if (e.key === "Delete") { e.preventDefault(); b.closeTab(b.tabs[i]!.id); return; }
    if (to < 0) return;
    e.preventDefault();
    const t = b.tabs[to]!;
    b.selectTab(t.id);
    requestAnimationFrame(() => tabRefs.current[t.id]?.focus());
  }

  return (
    <div className="border-b bg-chrome" data-testid="browser-chrome">
      <div className="flex items-end gap-1 px-2 pt-2">
        <div role="tablist" aria-label="Open tabs" className="flex min-w-0 items-end gap-1 overflow-x-auto pb-px">
          {b.tabs.map((t, i) => {
            const selected = t.id === b.activeId;
            const title = tabTitle(t);
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${t.id}-tab`}
                data-testid="browser-tab"
                data-selected={selected}
                ref={(el) => { tabRefs.current[t.id] = el; }}
                aria-selected={selected}
                aria-controls="browser-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => b.selectTab(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={cn(
                  "flex h-9 max-w-52 min-w-28 items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-left text-sm",
                  selected ? "bg-background font-medium" : "bg-secondary hover:bg-accent",
                )}
              >
                <TabIcon tab={t} />
                <span className="min-w-0 truncate">{title}</span>
              </button>
            );
          })}
        </div>
        <Button variant="ghost" size="icon" className="mb-0.5 size-8 shrink-0" onClick={b.newTab} aria-keyshortcuts="Alt+Shift+N">
          <Plus aria-hidden="true" />
          <span className="sr-only">New tab</span>
        </Button>
        <Button variant="ghost" size="icon" className="mb-0.5 size-8 shrink-0" onClick={() => b.closeTab(b.activeId)} aria-keyshortcuts="Alt+Shift+X">
          <X aria-hidden="true" />
          <span className="sr-only">Close tab {tabTitle(active)}</span>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t bg-background px-2 py-2">
        <Button variant="ghost" size="icon" disabled={!canBack} onClick={b.back} aria-keyshortcuts="Alt+Shift+B">
          <ArrowLeft aria-hidden="true" />
          <span className="sr-only">Back</span>
        </Button>
        <Button variant="ghost" size="icon" disabled={!canForward} onClick={b.forward} aria-keyshortcuts="Alt+Shift+G">
          <ArrowRight aria-hidden="true" />
          <span className="sr-only">Forward</span>
        </Button>
        <Button variant="ghost" size="icon" onClick={b.reload} disabled={!url} aria-keyshortcuts="Alt+Shift+E">
          <RotateCw aria-hidden="true" />
          <span className="sr-only">Reload</span>
        </Button>
        <form
          role="search"
          aria-label="Address bar"
          className="order-last min-w-0 basis-full sm:order-none sm:basis-0 sm:flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void b.navigate(text);
          }}
        >
          <label htmlFor="address-bar" className="sr-only">
            Address or search terms
          </label>
          <Input
            id="address-bar"
            ref={addressRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Enter a web address or search terms"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-keyshortcuts="/ Alt+Shift+L"
            className="rounded-full bg-chrome px-4"
          />
        </form>
        <Button
          variant="ghost" size="icon" onClick={() => void star.toggle()} disabled={!/^https?:\/\//i.test(address) || star.busy}
          aria-pressed={!!star.bookmark} aria-keyshortcuts="Alt+Shift+D" data-testid="bookmark-toggle"
        >
          <Star aria-hidden="true" className={cn(star.bookmark && "fill-current")} />
          <span className="sr-only">{star.bookmark ? "Remove bookmark" : "Bookmark this page"}</span>
        </Button>
        <BookmarksMenu />
        <Button variant="ghost" size="icon" onClick={() => setHelp(true)} aria-keyshortcuts="? Alt+Shift+H" data-testid="help-button">
          <CircleHelp aria-hidden="true" />
          <span className="sr-only">Keyboard shortcuts and link marks</span>
        </Button>
      </div>

      {content.kind !== "blank" && content.kind !== "loading" ? (
        <div className="flex flex-wrap items-center gap-2 border-t bg-background px-2 py-1.5" data-testid="page-actions">
          <SourceBadge tab={active} />
          <div role="radiogroup" aria-label="View" className="flex rounded-md border">
            {MODES.map(({ mode: m, label, need }) => {
              const available = need === "live" ? alternatives.includes("live") && ev.connectivity !== "offline" : alternatives.includes(need);
              const checked = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={!available && !checked}
                  onClick={() => b.setMode(m)}
                  className={cn("px-3 py-1 text-sm first:rounded-l-md last:rounded-r-md disabled:opacity-50", checked ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                >
                  {label}
                  {m === "original" ? <span className="sr-only"> (live site)</span> : null}
                </button>
              );
            })}
          </div>
          {canSave ? (
            <Button size="sm" variant="outline" onClick={saveNow} aria-keyshortcuts="Alt+Shift+S" data-testid="save-button">
              <Save aria-hidden="true" /> {ev.connectivity === "offline" ? "Queue for later" : "Save for offline"}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={openLive} disabled={ev.connectivity === "offline" || !/^https?:\/\//i.test(liveHref)} aria-keyshortcuts="Alt+Shift+U" data-testid="open-live">
            <ExternalLink aria-hidden="true" /> Open live site<span className="sr-only"> in a new browser tab</span>
          </Button>
          {content.kind === "archive" ? (
            <Button size="sm" variant="outline" onClick={onToggleFind} aria-pressed={findOpen} aria-keyshortcuts="Alt+Shift+F" data-testid="find-toggle">
              <Search aria-hidden="true" /> Find in page
            </Button>
          ) : null}
        </div>
      ) : null}
      <ShortcutsDialog open={help} onOpenChange={setHelp} singleKeys={singleKeys} onSingleKeys={setSingle} returnFocusTo={helpOpener} />
    </div>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  const { connectivity } = useEvents();
  const s = tabSource(tab);
  const eff: Source = s === "live" && connectivity === "offline" ? "offline" : s;
  if (eff === "blank") return null;
  const { label, icon: Icon } = SOURCE_TEXT[eff];
  return (
    <span data-testid="tab-icon" data-source={eff} className="shrink-0">
      <Icon className={cn("size-3.5", eff === "loading" && "animate-spin")} aria-hidden="true" />
      <span className="sr-only">{label}: </span>
    </span>
  );
}
