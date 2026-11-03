"use client";

import * as React from "react";
import Link from "next/link";
import { Check, CircleDashed, Cloud, FileText, Globe, HardDriveDownload, Library, Loader2, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useBrowser } from "@/components/browser/tabs";
import { useEvents } from "@/components/layout/events";
import { useToast } from "@/components/ui/toast";
import { errorMessage, post } from "@/lib/api";
import { AVAILABILITY_LABELS, displayAddress, markedParts, typeLabel, type SearchResult } from "@/lib/search";
import { safeHttpUrl } from "@/lib/online-search";
import type { SaveResponse } from "@/lib/types";

const day = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(d);
};

/** Archived favicons only. A result carries a same-origin path when the server has one; nothing is ever fetched from the site. */
function Favicon({ result }: { result: SearchResult }) {
  const [failed, setFailed] = React.useState(false);
  const src = result.faviconUrl && result.faviconUrl.startsWith("/") && !result.faviconUrl.startsWith("//") ? result.faviconUrl : null;
  if (src && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" width={16} height={16} className="size-4 shrink-0 rounded-sm" onError={() => setFailed(true)} data-testid="result-favicon" />;
  }
  const Icon = result.type === "pdf" ? FileText : Globe;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

const AVAIL_ICON = { cached: Check, partial: CircleDashed, queued: Loader2, online_only: Cloud, zim: Library } as const;
const AVAIL_VARIANT = { cached: "success", partial: "warning", queued: "secondary", online_only: "outline", zim: "success" } as const;

export function ResultItem({ result, headingId, onSaveOnline }: { result: SearchResult; headingId: string; onSaveOnline?: (r: SearchResult) => Promise<void> }) {
  const b = useBrowser();
  const ev = useEvents();
  const { toast } = useToast();
  const [save, setSave] = React.useState<"idle" | "saving" | "queued">("idle");
  // A web result that has since been saved is a saved page like any other.
  const local = (result.origin !== "online" && result.availability !== "online_only") || result.availability === "cached" || result.availability === "partial";
  const AvIcon = AVAIL_ICON[result.availability];
  const canSave = result.actions?.saveForOffline ?? result.availability === "online_only";
  const address = displayAddress(result.url);
  // Provider addresses are untrusted: only http and https ever become a link.
  const liveUrl = safeHttpUrl(result.url);
  const href = local ? (result.actions?.open || (result.pageId ? `/library/pages/${result.pageId}` : result.url)) : liveUrl;
  const providers = (result.attribution ?? []).filter((a) => a.kind === "provider").map((a) => a.name);

  function openPackage() {
    b.openInBrowser(result.url);
  }

  function open(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!local || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    // A PDF cannot run inside the sandboxed frame, so its title opens the extracted text.
    b.openInBrowser(result.url, result.type === "pdf" ? { mode: "reader" } : undefined);
  }

  async function saveForOffline() {
    setSave("saving");
    try {
      if (onSaveOnline) await onSaveOnline(result);
      else await post<SaveResponse>("/api/browser/save", { url: result.url, queue: ev.connectivity === "offline" });
      setSave("queued");
      toast({ title: "Saving for offline", description: result.title || result.url, variant: "success" });
    } catch (e) {
      setSave("idle");
      toast({ title: "Couldn't start the save", description: errorMessage(e), variant: "error" });
    }
  }

  // Package hits mark matches with <b>, archive hits with <mark>. Either way only that one tag is recognised and the text is never HTML.
  const isZim = result.origin === "zim" && !!result.zimId;
  const tag = isZim ? "b" : "mark";
  const parts = markedParts(result.snippet ?? "", tag);
  const titleParts = result.titleHtml ? markedParts(result.titleHtml, tag) : null;
  const Mark = tag;
  const titleNode = titleParts?.length ? titleParts.map((p, i) => (p.mark ? <Mark key={i} className="rounded-sm bg-amber-200 px-0.5 font-semibold text-amber-950 dark:bg-amber-800 dark:text-amber-50">{p.text}</Mark> : <React.Fragment key={i}>{p.text}</React.Fragment>)) : result.title || address;
  const packageName = result.sourceName || result.domain || "Knowledge package";
  const saved = day(result.capturedAt);
  const published = day(result.publishedAt);
  const meta = [result.sourceName, ...(result.collections ?? []).map((c) => c.name)].filter(Boolean);

  return (
    <article className="min-w-0 py-4" data-testid="search-result" data-result-key={result.key} data-availability={result.availability} data-origin={result.origin} aria-labelledby={headingId}>
      <div className="mb-0.5 flex min-w-0 items-center gap-2 text-sm">
        {isZim ? <Library className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <Favicon result={result} />}
        {isZim ? (
          <span className="min-w-0 truncate text-muted-foreground" data-testid="result-origin" data-package={packageName}>{packageName}</span>
        ) : (
          <span className="min-w-0 truncate text-muted-foreground" data-testid="result-address" title={local && address === "Imported document" ? undefined : result.url}>{address}</span>
        )}
      </div>
      <h3 id={headingId} className="text-lg leading-snug font-medium [overflow-wrap:anywhere]">
        {isZim ? (
          <button type="button" onClick={openPackage} className="text-left text-primary underline-offset-4 hover:underline" data-testid="result-title">
            {titleNode}
          </button>
        ) : local ? (
          <Link href={href ?? result.url} onClick={open} className="text-primary underline-offset-4 hover:underline" data-testid="result-title">
            {titleNode}
          </Link>
        ) : href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline" data-testid="result-title">
            {titleNode}
            <span className="sr-only"> (opens the live site in a new browser tab)</span>
          </a>
        ) : (
          <span data-testid="result-title">{titleNode}</span>
        )}
      </h3>
      {parts.length ? (
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-foreground/90 [overflow-wrap:anywhere]" data-testid="result-snippet">
          {parts.map((p, i) =>
            p.mark ? (
              <Mark key={i} className="rounded-sm bg-amber-200 px-0.5 font-medium text-amber-950 dark:bg-amber-800 dark:text-amber-50">{p.text}</Mark>
            ) : (
              <React.Fragment key={i}>{p.text}</React.Fragment>
            ),
          )}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <Badge variant={AVAIL_VARIANT[result.availability]} data-testid="result-availability">
          <AvIcon className={result.availability === "queued" ? "size-3 animate-spin" : "size-3"} aria-hidden="true" />
          {AVAILABILITY_LABELS[result.availability]}
        </Badge>
        {result.type && result.type !== "html" ? <Badge variant="outline">{typeLabel(result.type)}</Badge> : null}
        {saved ? <span data-testid="result-saved-date">Saved {saved}</span> : null}
        {published ? <span>Published {published}</span> : null}
        {meta.length ? <span data-testid="result-meta">{meta.join(" · ")}</span> : null}
        {result.alsoOnline ? <span>Also on the web</span> : null}
        {providers.length ? <span data-testid="result-providers">From {providers.join(", ")}</span> : null}
        {canSave && !local && result.availability !== "queued" && liveUrl ? (
          save === "queued" ? (
            <span className="inline-flex items-center gap-1 text-foreground" role="status"><Check className="size-3.5" aria-hidden="true" /> Saving for offline</span>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void saveForOffline()} disabled={save === "saving"} data-testid="result-save">
              {save === "saving" ? <Loader2 className="animate-spin" aria-hidden="true" /> : ev.connectivity === "offline" ? <HardDriveDownload aria-hidden="true" /> : <Save aria-hidden="true" />}
              {ev.connectivity === "offline" ? "Queue for later" : "Save for offline"}
              <span className="sr-only">: {result.title || address}</span>
            </Button>
          )
        ) : null}
        {result.alsoAt?.length ? (
          <span data-testid="result-also-at">
            Also at {result.alsoAt.length} other {result.alsoAt.length === 1 ? "page" : "pages"}:{" "}
            {result.alsoAt.slice(0, 3).map((a, i) => (
              <React.Fragment key={a.pageId}>
                {i > 0 ? ", " : ""}
                <button type="button" className="underline underline-offset-4 hover:no-underline" onClick={() => b.openInBrowser(a.url)}>{a.title || displayAddress(a.url)}</button>
              </React.Fragment>
            ))}
          </span>
        ) : null}
        {isZim && result.archivedAs ? (
          <Link href={`/library/pages/${result.archivedAs}`} className="underline-offset-4 hover:underline" data-testid="result-archived-as">
            Also saved as a page<span className="sr-only">: {result.title}</span>
          </Link>
        ) : null}
        {isZim ? (
          <Link href={`/library/packages/${result.zimId}`} className="underline-offset-4 hover:underline" data-testid="result-package-details">
            Package details<span className="sr-only">: {packageName}</span>
          </Link>
        ) : null}
        {local && result.pageId ? (
          <Link href={`/library/pages/${result.pageId}`} className="underline-offset-4 hover:underline" data-testid="result-details">
            Page details<span className="sr-only">: {result.title || address}</span>
          </Link>
        ) : null}
      </div>
    </article>
  );
}
