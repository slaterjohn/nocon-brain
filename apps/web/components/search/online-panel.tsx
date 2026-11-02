"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDownUp, CloudDownload, Download, Globe, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorSentence } from "@/lib/online-search";
import type { Coverage } from "@/lib/search";
import { failedProviders, heldCount, providersWithMore, type StreamState } from "@/lib/search-stream";
import type { HoldCause } from "@/lib/search-freeze";

/** Counts only. Never a share of the internet. */
export function coverageText(cov: Coverage, withWeb: boolean): string {
  const base = `${cov.cachedMatches} ${cov.cachedMatches === 1 ? "match" : "matches"} in your saved pages${cov.partial ? `, ${cov.partial} partly saved` : ""}`;
  if (!withWeb) return base;
  const web = [`${cov.onlineMatches} found on the web`, `${cov.onlineNotArchived} not saved yet`];
  if (cov.queued) web.push(`${cov.queued} waiting to be saved`);
  return `${base}. ${web.join(", ")}.`;
}

/**
 * The strip above the list while a web search runs. Its height is reserved from the first paint and the text in it is one line per
 * row, so nothing below it moves when a provider answers. It is not a live region: the single announcement is made elsewhere.
 */
export function OnlineStrip({
  stream, cause, pending, timeBoxExpired, moreBusy, onShow, onRerank, onLoadMore, onImprove, coverage,
}: {
  stream: StreamState;
  cause: HoldCause;
  pending: boolean;
  timeBoxExpired: boolean;
  moreBusy: boolean;
  onShow: () => void;
  onRerank: () => void;
  onLoadMore: () => void;
  onImprove: () => void;
  coverage?: Coverage;
}) {
  const waiting = heldCount(stream);
  const names = stream.providers.filter((p) => p.state === "pending").map((p) => p.name);
  const more = providersWithMore(stream).length > 0;
  const uncached = (coverage?.onlineNotArchived ?? 0) > 0;
  let status: string;
  if (waiting > 0) status = cause === "time_box" ? `${waiting} more web ${waiting === 1 ? "result arrived" : "results arrived"} after the first two seconds.` : `${waiting} new web ${waiting === 1 ? "result is" : "results are"} ready. The list stays as it is until you ask.`;
  else if (pending) status = timeBoxExpired && names.length ? `Still waiting for ${names.join(", ")}.` : "Searching the web…";
  else status = "Web search finished.";
  return (
    <section aria-label="Web results" data-testid="online-strip" className="mb-3 min-h-[5.75rem] rounded-md border bg-muted/40 p-3 text-sm">
      {coverage ? <p className="truncate" data-testid="coverage-strip" title={coverageText(coverage, true)}>{coverageText(coverage, true)}</p> : <p className="h-5" />}
      <p className="mt-1 flex items-center gap-2 truncate text-muted-foreground" data-testid="online-status">
        {pending && waiting === 0 ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : <Globe className="size-3.5 shrink-0" aria-hidden="true" />}
        <span className="truncate">{status}</span>
      </p>
      <div className="mt-2 flex min-h-8 flex-wrap items-center gap-2">
        {waiting > 0 ? (
          <Button size="sm" onClick={onShow} data-testid="show-new">Show {waiting} new web {waiting === 1 ? "result" : "results"}</Button>
        ) : null}
        {stream.reorderAvailable ? (
          <Button size="sm" variant="outline" onClick={onRerank} data-testid="rerank"><ArrowDownUp aria-hidden="true" /> Re-rank with web results</Button>
        ) : null}
        {waiting === 0 && more && (stream.done || timeBoxExpired) ? (
          <Button size="sm" variant="outline" onClick={onLoadMore} disabled={moreBusy} data-testid="load-more-web">
            {moreBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <CloudDownload aria-hidden="true" />} Load more from the web
          </Button>
        ) : null}
        {uncached ? (
          <Button size="sm" variant="outline" onClick={onImprove} data-testid="improve-coverage"><Download aria-hidden="true" /> Improve offline coverage</Button>
        ) : null}
      </div>
    </section>
  );
}

/** Below the list: a placeholder of fixed height while the web is searched, then what each provider did, errors with their codes. */
export function OnlineFooter({ stream, pending, disclosure }: { stream: StreamState; pending: boolean; disclosure: string }) {
  const failed = failedProviders(stream);
  return (
    <section aria-label="Web search providers" className="mt-2 space-y-2 text-sm" data-testid="online-footer">
      <div className="h-16" data-testid="online-placeholder" aria-hidden={pending ? "true" : undefined}>
        {pending ? (
          <div className="space-y-2 py-1" aria-hidden="true">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-full max-w-3xl" />
          </div>
        ) : (
          <p className="line-clamp-3 text-muted-foreground" data-testid="online-disclosure">{disclosure}</p>
        )}
      </div>
      {stream.providers.length ? (
        <ul className="space-y-1" data-testid="provider-runs">
          {stream.providers.map((p) => (
            <li key={p.id} className="flex flex-wrap items-baseline gap-x-2" data-testid="provider-run" data-state={p.state}>
              {p.state === "error" && p.error ? (
                <>
                  <TriangleAlert className="size-3.5 translate-y-0.5 self-center text-warning" aria-hidden="true" />
                  <span>{errorSentence(p.name, p.error.code)}.</span>
                  <code className="rounded bg-muted px-1 text-xs" data-testid="provider-error-code">{p.error.code}</code>
                  <span className="text-muted-foreground">{p.error.message}</span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {p.name}: {p.state === "pending" ? "waiting" : p.state === "skipped" ? "skipped" : `${p.count} ${p.count === 1 ? "result" : "results"}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {failed.length ? (
        <p className="text-muted-foreground">
          Results from your saved pages are not affected. <Link href="/storage/online-search" className="underline underline-offset-4 hover:no-underline">Check the search providers</Link>.
        </p>
      ) : null}
    </section>
  );
}

/** Shown instead of the strip when no web search ran, with the reason and a way to change it. */
export function OnlineNote({ reason, scopeOnline }: { reason: "off" | "no_provider" | "offline" | null; scopeOnline: boolean }) {
  if (reason === null) return null;
  const text =
    reason === "offline"
      ? "You are offline. Results come from your saved pages."
      : reason === "no_provider"
        ? "No search provider is set up, so results come from your saved pages."
        : "Online search is off. Results come from your saved pages.";
  return (
    <p className="mt-1.5 text-xs text-muted-foreground" data-testid="online-note">
      {text}{" "}
      {reason !== "offline" ? <Link href="/storage/online-search" className="underline underline-offset-4 hover:no-underline">{scopeOnline ? "Set up online search" : "Online search settings"}</Link> : null}
    </p>
  );
}
