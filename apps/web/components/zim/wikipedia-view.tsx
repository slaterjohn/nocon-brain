"use client";

import * as React from "react";
import Link from "next/link";
import { Globe, RotateCw } from "lucide-react";
import { errorMessage, post, useApi } from "@/lib/api";
import type { Source } from "@/lib/types";
import {
  breakerText, coverageText, crawlBody, crawlStartBody, CRAWL_DEFAULTS, formatWait, levelRows, MAX_DEPTH, MAX_PAGES, validateCrawl, WIKI_LANGUAGES, wikipediaErrorText,
  parseStart, type CrawlDraft, type FieldErrors, type WikipediaPreview, type WikipediaStatus,
} from "@/lib/zim";
import { PRIORITIES } from "@/lib/library-copy";
import { formatBytes, formatDate } from "@/lib/utils";
import type { Priority } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { ErrorSummary, type SummaryItem } from "@/components/common/error-summary";
import { Field } from "@/components/common/form";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { LibraryNav } from "@/components/library/library-nav";
import { Notice } from "@/components/storage/shared";

/** Contact, pace and circuit breaker. `NCB_CONTACT` is set on the server; the page can only say whether it is. */
export function WikipediaStatusPanel() {
  const { toast } = useToast();
  const status = useApi<WikipediaStatus>("/api/wikipedia/status", { refreshInterval: 10_000 });
  const [busy, setBusy] = React.useState(false);
  const s = status.data;
  const br = s ? breakerText(s) : null;

  async function reset() {
    setBusy(true);
    try {
      const next = await post<WikipediaStatus>("/api/wikipedia/reset");
      status.setData(next);
      toast({ title: "Requests can start again", description: "The pause was cleared.", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't clear the pause", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="wiki-status-h" className="rounded-lg border p-4" data-testid="wikipedia-status">
      <h2 id="wiki-status-h" className="mb-2 text-base font-semibold">Wikipedia status</h2>
      {status.isLoading ? <Skeleton className="h-16" /> : null}
      {status.error ? <ErrorState title="Couldn't load the status" message={status.error.message} onRetry={() => void status.mutate()} /> : null}
      {s && br ? (
        <div className="space-y-3">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Contact</dt>
              <dd data-testid="wiki-contact" data-configured={s.contactConfigured}>{s.contactConfigured ? "Set" : "Not set"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Requests</dt>
              <dd data-testid="wiki-breaker" data-state={s.breaker.state}>{br.label}{s.breaker.reopensAt ? ` until ${formatDate(s.breaker.reopensAt)}` : ""}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Pace</dt>
              <dd>At most one request every {Math.round(s.minIntervalMs / 100) / 10} seconds</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sent so far</dt>
              <dd>{s.requests.toLocaleString("en-GB")} requests, {formatBytes(s.bytes)}{s.rateLimited ? `, asked to slow down ${s.rateLimited} ${s.rateLimited === 1 ? "time" : "times"}` : ""}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">{br.help}</p>
          {s.contactConfigured && s.userAgentPreview ? (
            <p className="text-xs text-muted-foreground">Sent to Wikipedia to say who is asking: <code className="break-all">{s.userAgentPreview}</code></p>
          ) : (
            <Notice tone="warning" title="NoConBrain has no contact for Wikipedia, so it sends no requests" testId="wiki-contact-help">
              Wikipedia asks every program that reads it to say who runs it. Set <code>NCB_CONTACT</code> in the server&apos;s environment to a web address (such as https://example.org/about) or an email address, whichever you choose to be reachable at, then restart the server. It is sent with each request and is not shown to anyone else. Saved pages and packages work without it.
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void reset()} disabled={busy || !br.open} data-testid="wiki-reset">
              <RotateCw aria-hidden="true" /> {busy ? "Clearing…" : "Try again now"}
            </Button>
            {!br.open ? <span className="text-xs text-muted-foreground">Available when requests are paused.</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

const fid = (k: string) => `wiki-${k}`;

function PreviewPanel({ p, draftDepth }: { p: WikipediaPreview; draftDepth: number }) {
  const rows = levelRows(p);
  const t = p.totals;
  return (
    <section aria-labelledby="preview-h" className="space-y-4 rounded-lg border p-4" data-testid="wiki-preview">
      <div>
        <h2 id="preview-h" className="text-base font-semibold">What this would save</h2>
        <p className="text-sm text-muted-foreground">
          Start: <strong data-testid="preview-title">{p.article.title.replace(/_/g, " ")}</strong>
          {p.article.redirectedFrom ? ` (redirected from ${p.article.redirectedFrom.replace(/_/g, " ")})` : ""}. All figures are estimates. {draftDepth > 1 ? "Levels after the first are guesses." : ""}
        </p>
      </div>
      <Table aria-label="Pages per level">
        <caption className="sr-only">Pages per level, with how many come from a package and how many are skipped</caption>
        <TableHeader>
          <TableRow>
            <TableHead>Level</TableHead>
            <TableHead className="text-right">Pages to fetch</TableHead>
            <TableHead className="text-right">Already in a package</TableHead>
            <TableHead className="text-right">Skipped</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.depth} data-testid="preview-level" data-estimated={r.estimated}>
              <TableCell>{r.label}</TableCell>
              <TableCell className="text-right tabular-nums">{r.estimated ? "about " : ""}{r.willFetch.toLocaleString("en-GB")}</TableCell>
              <TableCell className="text-right tabular-nums">{r.estimated ? "about " : ""}{r.inPackage.toLocaleString("en-GB")}</TableCell>
              <TableCell className="text-right tabular-nums">{r.estimated ? "about " : ""}{r.skipped.toLocaleString("en-GB")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="preview-totals">
        <div className="rounded-md bg-muted/50 p-3"><dt className="text-xs text-muted-foreground">Articles (estimate)</dt><dd className="text-lg font-semibold tabular-nums">{t.pages.toLocaleString("en-GB")}</dd></div>
        <div className="rounded-md bg-muted/50 p-3"><dt className="text-xs text-muted-foreground">Requests (estimate)</dt><dd className="text-lg font-semibold tabular-nums" data-testid="preview-requests">{t.requests.toLocaleString("en-GB")}</dd></div>
        <div className="rounded-md bg-muted/50 p-3"><dt className="text-xs text-muted-foreground">Time at {p.pace.requestsPerSecond} request a second</dt><dd className="text-lg font-semibold" data-testid="preview-time">about {formatWait(t.seconds)}</dd></div>
        <div className="rounded-md bg-muted/50 p-3"><dt className="text-xs text-muted-foreground">Size (estimate)</dt><dd className="text-lg font-semibold">{formatBytes(t.bytes, 0)}</dd></div>
      </dl>
      <p className="text-sm" data-testid="preview-coverage">{coverageText(p)}</p>
      {p.sample.length ? (
        <div>
          <h3 className="mb-1 text-sm font-medium">The first links it would follow</h3>
          <ul className="flex flex-wrap gap-2 text-sm" data-testid="preview-sample">
            {p.sample.slice(0, 12).map((x) => (
              <li key={x.title} className="rounded-full border px-2.5 py-0.5">{x.title.replace(/_/g, " ")}{x.inKnowledgePackage ? " (in a package)" : ""}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.warnings.length ? (
        <div role="group" aria-label="Warnings" className="rounded-md border border-warning p-3" data-testid="preview-warnings">
          <h3 className="mb-1 text-sm font-medium">Worth knowing</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">The preview itself asked Wikipedia {p.requestsMade} {p.requestsMade === 1 ? "time" : "times"} and saved nothing.</p>
    </section>
  );
}

/** The Wikipedia topic crawl: a form, a preview of the cost, then the same source and download job as any crawl. */
export function WikipediaView() {
  const { toast } = useToast();
  const status = useApi<WikipediaStatus>("/api/wikipedia/status", { refreshInterval: 10_000 });
  const [d, setD] = React.useState<CrawlDraft>(CRAWL_DEFAULTS);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [general, setGeneral] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{ p: WikipediaPreview; key: string } | null>(null);
  const [busy, setBusy] = React.useState<"preview" | "start" | null>(null);
  const [started, setStarted] = React.useState<{ source: Source; downloadIds: string[] } | null>(null);
  const [advOpen, setAdvOpen] = React.useState(false);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const [tick, setTick] = React.useState(0);
  const previewRef = React.useRef<HTMLDivElement>(null);
  const noContact = status.data ? !status.data.contactConfigured : false;
  const key = JSON.stringify({ ...d, name: "", priority: "" });
  const fresh = preview?.key === key;
  const startKind = parseStart(d.start);

  React.useEffect(() => {
    if (tick) summaryRef.current?.focus();
  }, [tick]);

  const set = (patch: Partial<CrawlDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      return next;
    });
    setStarted(null);
  };

  function fail(fields: FieldErrors, more: string | null) {
    setErrors(fields);
    setGeneral(more);
    setTick((t) => t + 1);
  }

  async function runPreview(e: React.FormEvent) {
    e.preventDefault();
    const local = validateCrawl(d);
    if (Object.keys(local).length) return fail(local, null);
    setBusy("preview");
    setGeneral(null);
    setErrors({});
    try {
      const p = await post<WikipediaPreview>("/api/wikipedia/preview", crawlBody(d));
      setPreview({ p, key });
      requestAnimationFrame(() => previewRef.current?.focus());
    } catch (err) {
      setPreview(null);
      fail({}, wikipediaErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setBusy("start");
    try {
      const out = await post<{ source: Source; downloadIds: string[] }>("/api/wikipedia/crawl", crawlStartBody(d));
      setStarted(out);
      toast({ title: "Crawl started", description: out.source.name, variant: "success" });
    } catch (err) {
      fail({}, wikipediaErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  const summary: SummaryItem[] = [
    ...Object.entries(errors).map(([k, message]) => ({ id: fid(k), message })),
    ...(general ? [{ id: fid("start"), message: general }] : []),
  ];

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <PageHeader title="Library" description="Pages you have saved. They open without internet." />
      <LibraryNav />
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Save a Wikipedia topic</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Save an article and the articles it links to. NoConBrain asks Wikipedia for one page a second and shows the cost first. Wikipedia text is licensed CC BY-SA 4.0, and each saved article keeps its credit. For many articles, a Wikipedia package is faster and kinder to Wikipedia.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <form onSubmit={(e) => void runPreview(e)} noValidate className="space-y-4 rounded-lg border p-4" data-testid="wiki-form" aria-label="Wikipedia topic">
            <ErrorSummary ref={summaryRef} items={summary} />
            <Field id={fid("start")} label="Article title or Wikipedia address" hint="For example Black hole, or https://en.wikipedia.org/wiki/Black_hole." error={errors.start}>
              {(p) => <Input {...p} value={d.start} onChange={(e) => set({ start: e.target.value })} autoComplete="off" spellCheck={false} data-testid="wiki-start" />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id={fid("language")} label="Language" hint={startKind && "url" in startKind ? "Taken from the address." : "The Wikipedia to read."} error={errors.language}>
                {(p) => (
                  <Select {...p} value={d.language} disabled={!!startKind && "url" in startKind} onChange={(e) => set({ language: e.target.value })} data-testid="wiki-language">
                    {WIKI_LANGUAGES.concat(WIKI_LANGUAGES.some((l) => l.value === d.language) ? [] : [{ value: d.language, label: d.language }]).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </Select>
                )}
              </Field>
              <Field id={fid("depth")} label="Links to follow" hint={`0 to ${MAX_DEPTH}. 1 is the article and what it links to.`} error={errors.depth}>
                {(p) => <Input {...p} inputMode="numeric" value={d.depth} onChange={(e) => set({ depth: e.target.value })} autoComplete="off" data-testid="wiki-depth" />}
              </Field>
              <Field id={fid("maxPages")} label="Most articles" hint={`Up to ${MAX_PAGES.toLocaleString("en-GB")}.`} error={errors.maxPages}>
                {(p) => <Input {...p} inputMode="numeric" value={d.maxPages} onChange={(e) => set({ maxPages: e.target.value })} autoComplete="off" data-testid="wiki-max-pages" />}
              </Field>
            </div>
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <Checkbox id={fid("preferZim")} checked={d.preferZim} onCheckedChange={(v) => set({ preferZim: v === true })} data-testid="wiki-prefer-zim" />
                <Label htmlFor={fid("preferZim")} className="font-normal">Use package copies where there are any<span className="block text-xs text-muted-foreground">An article already in an installed Wikipedia package is linked, not fetched. Fewer requests, less space, and the link works offline.</span></Label>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox id={fid("images")} checked={d.images} onCheckedChange={(v) => set({ images: v === true })} data-testid="wiki-images" />
                <Label htmlFor={fid("images")} className="font-normal">Save images<span className="block text-xs text-muted-foreground">Each image keeps its own credit. Turn this off to save text only. It is much faster.</span></Label>
              </div>
            </div>
            <AdvancedSettings open={advOpen} onOpenChange={setAdvOpen} id="wiki-adv" title="Advanced settings">
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Leave out</legend>
                <div className="flex items-center gap-2"><Checkbox id={fid("skipDisambiguation")} checked={d.skipDisambiguation} onCheckedChange={(v) => set({ skipDisambiguation: v === true })} /><Label htmlFor={fid("skipDisambiguation")} className="font-normal">Disambiguation pages</Label></div>
                <div className="flex items-center gap-2"><Checkbox id={fid("skipLists")} checked={d.skipLists} onCheckedChange={(v) => set({ skipLists: v === true })} /><Label htmlFor={fid("skipLists")} className="font-normal">Lists, indexes and outlines</Label></div>
                <div className="flex items-center gap-2"><Checkbox id={fid("skipYears")} checked={d.skipYears} onCheckedChange={(v) => set({ skipYears: v === true })} /><Label htmlFor={fid("skipYears")} className="font-normal">Years, dates and timelines</Label></div>
              </fieldset>
              <Field id={fid("name")} label="Name of the source" optional hint="Shown in the Library and on the Downloads screen. Leave empty to use the article title.">
                {(p) => <Input {...p} value={d.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />}
              </Field>
              <Field id={fid("priority")} label="Priority">
                {(p) => <Select {...p} value={d.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>{PRIORITIES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>}
              </Field>
            </AdvancedSettings>
            {noContact ? <p className="text-sm text-warning" data-testid="wiki-form-nocontact">Wikipedia requests are off until a contact is set. See the status panel.</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy !== null || noContact} data-testid="wiki-preview-button">{busy === "preview" ? "Asking Wikipedia…" : "Preview"}</Button>
              <Button type="button" variant="default" onClick={() => void start()} disabled={!fresh || busy !== null || noContact} data-testid="wiki-start-button" aria-describedby="wiki-start-hint">
                {busy === "start" ? "Starting…" : "Start the crawl"}
              </Button>
            </div>
            <p id="wiki-start-hint" className="text-xs text-muted-foreground">{fresh ? "The preview matches these settings." : "Preview first. Starting is available once the preview matches the settings above."}</p>
          </form>

          <div role="status" aria-live="polite" data-testid="wiki-preview-status">
            {busy === "preview" ? <LoadingSkeleton rows={3} label="Asking Wikipedia for a preview" /> : null}
          </div>
          {preview && busy !== "preview" ? <div ref={previewRef} tabIndex={-1} className="outline-none"><PreviewPanel p={preview.p} draftDepth={Number(d.depth)} /></div> : null}
          {started ? (
            <div role="status" className="rounded-lg border border-success/50 p-4" data-testid="wiki-started">
              <p className="font-medium">The crawl has started.</p>
              <p className="mt-1 text-sm">
                It is the source <Link href={`/library/sources/${started.source.id}`} className="text-primary underline underline-offset-4">{started.source.name}</Link>. Follow its progress on <Link href="/downloads" className="text-primary underline underline-offset-4">Downloads</Link>.
              </p>
            </div>
          ) : null}
        </div>
        <div className="min-w-0"><WikipediaStatusPanel /></div>
      </div>
    </div>
  );
}
