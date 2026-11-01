"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, ExternalLink, Globe, Save, Search, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Wordmark } from "@/components/layout/app-shell";
import { ErrorState, LoadingSkeleton } from "@/components/layout/states";
import { useEvents } from "@/components/layout/events";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api";
import { BrowserChrome } from "./chrome";
import { CaptureStatus } from "./capture-status";
import { FindBar } from "./find-bar";
import { hostOf, useBrowser, type Tab } from "./tabs";

/** The sandbox for archived content: popups only. No `allow-scripts`, no `allow-same-origin` (A-14, decision D-5). */
export const FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

function SearchHome() {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16">
      <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">
        <Wordmark />
      </h1>
      <form
        role="search"
        className="flex w-full max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <label htmlFor="home-search" className="sr-only">
          Search your archive and the web
        </label>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" aria-hidden="true" />
          <Input id="home-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" autoComplete="off" className="h-10 rounded-full pl-9" />
        </div>
        <Button type="submit" className="h-10 rounded-full px-5">
          Search
        </Button>
      </form>
    </div>
  );
}

function Panel({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 sm:p-8">
      <div className="flex items-start gap-3">
        <Icon className="mt-1 size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      </div>
      {children}
    </div>
  );
}

/** Not saved, and the internet may be there: offer the live site and a save. */
function LivePanel({ tab }: { tab: Tab }) {
  const b = useBrowser();
  const ev = useEvents();
  const { toast } = useToast();
  const c = tab.content;
  if (c.kind !== "live") return null;
  const hasCopy = c.alternatives.includes("archive");
  const start = () => b.save().catch((e) => toast({ title: "Couldn't start the save", description: errorMessage(e), variant: "error" }));
  return (
    <Panel title={hasCopy ? "A saved copy exists" : "This page is not saved"} icon={Globe}>
      <p className="break-all text-sm text-muted-foreground" data-testid="live-url">{c.url}</p>
      <p className="text-sm">
        {hasCopy
          ? "You are looking at the original site view. The saved copy opens without internet."
          : "It opens on the live site only. Save it to read it later without internet, then follow its links between saved pages."}
      </p>
      <div className="flex flex-wrap gap-2">
        {hasCopy ? (
          <Button onClick={() => b.setMode("archived")}>
            <Archive aria-hidden="true" /> Open the saved copy
          </Button>
        ) : (
          <Button onClick={() => void start()} data-testid="panel-save">
            <Save aria-hidden="true" /> Save for offline
          </Button>
        )}
        <Button variant="outline" onClick={() => window.open(c.url, "_blank", "noopener,noreferrer")} disabled={ev.connectivity === "offline"}>
          <ExternalLink aria-hidden="true" /> Open live site<span className="sr-only"> in a new browser tab</span>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The live site opens in its own browser tab, outside NoConBrain. Sites that block being shown inside another page cannot be shown here.
      </p>
    </Panel>
  );
}

/** Not saved and no internet: say so, and offer to queue it. */
function OfflinePanel({ tab }: { tab: Tab }) {
  const b = useBrowser();
  const { toast } = useToast();
  const c = tab.content;
  if (c.kind !== "offline") return null;
  const queued = tab.saving?.downloadId ?? c.queued?.downloadId;
  return (
    <Panel title="This page is not saved, and you're offline" icon={WifiOff}>
      <p className="break-all text-sm text-muted-foreground" data-testid="offline-url">{c.url}</p>
      <p className="text-sm">
        {c.reason === "forced_offline" ? "Work offline is on, so nothing is fetched from the web." : "There is no internet connection right now."} Pages you saved earlier still open.
      </p>
      {queued ? (
        <p className="text-sm" role="status">This page is queued. It is saved when the connection returns.</p>
      ) : (
        <div>
          <Button
            onClick={() => b.save({ queue: true }).catch((e) => toast({ title: "Couldn't queue the page", description: errorMessage(e), variant: "error" }))}
            data-testid="panel-queue"
          >
            <Save aria-hidden="true" /> Queue to save when online
          </Button>
        </div>
      )}
    </Panel>
  );
}

function FrameHost({
  tab, active, register,
}: { tab: Tab; active: boolean; register: (id: string, el: HTMLIFrameElement | null) => void }) {
  const b = useBrowser();
  const c = tab.content;
  if (c.kind !== "archive") return null;
  return (
    <iframe
      // A new key is a new iframe: shell-initiated moves add nothing to the browser's session history (D-5).
      key={`${tab.id}-${c.frameKey}`}
      ref={(el) => register(tab.id, el)}
      title={`Saved page: ${c.current.title}`}
      src={c.frame.url}
      sandbox={FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={() => b.onFrameLoad(tab.id, c.frameKey)}
      hidden={!active}
      data-testid="archive-frame"
      className="w-full flex-1 border-0 bg-white"
      style={{ minHeight: "60dvh" }}
    />
  );
}

/** The Browser area: chrome plus the active tab's content. */
export function BrowserView() {
  const b = useBrowser();
  const addressRef = React.useRef<HTMLInputElement | null>(null);
  const frames = React.useRef<Record<string, HTMLIFrameElement | null>>({});
  const [findFor, setFindFor] = React.useState<string | null>(null);
  const active = b.active;
  const c = active.content;
  const findOpen = findFor === active.id && c.kind === "archive";
  const register = React.useCallback((id: string, el: HTMLIFrameElement | null) => { frames.current[id] = el; }, []);

  const toggleFind = React.useCallback(() => {
    setFindFor((cur) => (cur === active.id ? null : c.kind === "archive" ? active.id : cur));
  }, [active.id, c.kind]);

  const savingId = active.saving?.downloadId;
  const archiveTabs = b.tabs.filter((t) => t.content.kind === "archive");

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
      <BrowserChrome addressRef={addressRef} onToggleFind={toggleFind} findOpen={findOpen} />
      {savingId ? <CaptureStatus downloadId={savingId} onOpenSaved={b.reopen} /> : null}
      {findOpen ? <FindBar key={active.id + (c.kind === "archive" ? c.current.versionId : "")} tab={active} getFrame={() => frames.current[active.id] ?? null} onClose={() => {
        setFindFor(null);
        // Focus goes back to the control that opened the find bar (WCAG 2.4.3).
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="find-toggle"]')?.focus());
      }} /> : null}
      <div id="browser-panel" role="tabpanel" aria-label="Page content" aria-labelledby={`${active.id}-tab`} className="flex flex-1 flex-col">
        {c.kind === "blank" ? <SearchHome /> : null}
        {c.kind === "loading" ? (
          <div className="p-6">
            <LoadingSkeleton variant="page" label={`Opening ${hostOf(c.url)}`} />
          </div>
        ) : null}
        {c.kind === "error" ? (
          <div className="p-6">
            <h1 className="sr-only">Browser</h1>
            <ErrorState title="Couldn't open this address" message={c.message} onRetry={b.reload} />
          </div>
        ) : null}
        {c.kind === "live" ? <LivePanel tab={active} /> : null}
        {c.kind === "offline" ? <OfflinePanel tab={active} /> : null}
        {/* Every tab with a saved page keeps its frame, hidden when it is not the active tab, so scroll position and in-frame history stay. */}
        {archiveTabs.map((t) => (
          <FrameHost key={t.id} tab={t} active={t.id === active.id} register={register} />
        ))}
        {c.kind === "archive" ? <h1 className="sr-only">{c.current.title}</h1> : null}
      </div>
    </div>
  );
}
