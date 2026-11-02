"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Eye, Play, Upload } from "lucide-react";
import { ApiError, errorMessage, fieldErrors, patch, post, put, useApi } from "@/lib/api";
import type { RunResult, SetupStatus, Source, SourceCeilings, SourcePreview } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/input";
import { FormError, FormSection } from "@/components/common/form";
import { ErrorSummary } from "@/components/common/error-summary";
import { useToast } from "@/components/ui/toast";
import { describeRetention, describeSchedule } from "@/lib/describe";
import { SOURCE_TYPES, MODES, PRIORITIES, PROFILES } from "@/lib/library-copy";
import {
  CEILINGS, CRAWL_TYPES, buildInput, buildSchedule, buildWindow, draftFromSource, emptyDraft, isMoreAdvanced, isScopeAdvanced, isWebType, stepOfKey, validateDraft, type Draft,
} from "@/lib/source-draft";
import { formatBytes } from "@/lib/utils";
import { AddressSection, KeepSection, MoreAdvanced, ScheduleSection, TypeSection, fid } from "./source-fields";
import { useCollections, useSources } from "./hooks";
import { ImportDropzone, useImportLimits, useImportQueue } from "./import-upload";

const STEPS = ["Type", "Address and scope", "Schedule and priority", "Review"] as const;
/** Uploaded documents have no address and nothing to schedule: the last step is where the files are chosen. */
const IMPORT_STEPS = ["Type", "Name", "Priority and keeping", "Add files"] as const;

function range(a: number, b: number) {
  return a === b ? a.toLocaleString("en-GB") : `${a.toLocaleString("en-GB")} to ${b.toLocaleString("en-GB")}`;
}

/** The result of POST /api/sources/preview, always labelled as an estimate. */
export function PreviewPanel({ preview, loading, error }: { preview: SourcePreview | null; loading: boolean; error: string | null }) {
  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="preview-panel" aria-busy={loading}>
      <h3 className="text-sm font-semibold">What this will save</h3>
      <div role="status" aria-live="polite">
        {loading ? <Skeleton className="h-16" /> : null}
        {error && !loading ? <p className="text-sm text-destructive" data-testid="preview-error">{error}</p> : null}
      </div>
      {preview && !loading ? (
        <>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md bg-muted/50 p-3">
              <dt className="text-xs text-muted-foreground">Pages (estimate)</dt>
              <dd className="text-lg font-semibold" data-testid="preview-pages">{range(preview.estimate.pages.low, preview.estimate.pages.high)}</dd>
              <dd className="text-xs text-muted-foreground">{preview.estimate.basis}</dd>
            </div>
            <div className="rounded-md bg-muted/50 p-3">
              <dt className="text-xs text-muted-foreground">Size (estimate)</dt>
              <dd className="text-lg font-semibold" data-testid="preview-bytes">
                {formatBytes(preview.estimate.bytes.low, 0)} to {formatBytes(preview.estimate.bytes.high, 0)}
              </dd>
              <dd className="text-xs text-muted-foreground">Estimated from a sample{preview.estimate.confidence ? `, ${preview.estimate.confidence} confidence` : ""}. The real size can be lower or higher.</dd>
              <dd className="mt-1 text-xs text-muted-foreground" data-testid="preview-size-limit">Size limit: {formatBytes(preview.config.maxBytes, 0)}. The run stops when it reaches it.</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">These figures are an estimate. The real numbers can be lower or higher.</p>
          <div>
            <h4 className="mb-1 text-sm font-medium">How far it will go</h4>
            <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="preview-scope">
              {preview.scope.map((s) => <li key={s}>{s}</li>)}
              <li>Limits: {preview.config.depth} {preview.config.depth === 1 ? "link" : "links"} deep, {preview.config.maxPages.toLocaleString("en-GB")} pages, {formatBytes(preview.config.maxBytes, 0)}.</li>
            </ul>
          </div>
          {preview.warnings.length ? (
            <div role="group" aria-label="Warnings" className="rounded-md border border-warning p-3" data-testid="preview-warnings">
              <h4 className="mb-1 text-sm font-medium">Warnings</h4>
              <ul className="list-disc space-y-1 pl-5 text-sm">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Summary({ d, edit }: { d: Draft; edit: boolean }) {
  const type = SOURCE_TYPES.find((t) => t.value === d.type);
  const rows: [string, string][] = [
    ["Type", type?.label ?? ""],
    ["Name", d.name],
    ...(isWebType(d.type) ? ([["Address", d.startUrl]] as [string, string][]) : []),
    ...(CRAWL_TYPES.includes(d.type as never) ? ([["Mode", MODES.find((m) => m.value === d.mode)?.label ?? d.mode]] as [string, string][]) : []),
    ...(d.type !== "single_page" && isWebType(d.type) ? ([["Amount", PROFILES.find((p) => p.value === d.profile)?.label ?? d.profile]] as [string, string][]) : []),
    ["Runs", describeSchedule(d.schedKind === "manual" ? null : { kind: d.schedKind, minute: Number(d.minute), time: d.time, dayOfWeek: Number(d.dayOfWeek), cron: d.cron, timezone: d.timezone, enabled: true } as never)],
    ["Priority", PRIORITIES.find((p) => p.value === d.priority)?.label ?? d.priority],
    ["Retention", describeRetention(d.customRetention ?? { mode: d.retentionMode as "all", ...(d.retentionMode === "latest" ? { count: Number(d.retentionCount) } : {}), ...(d.retentionMode === "time" ? { days: Number(d.retentionDays) } : {}), ...(d.retentionMode === "budget" ? { bytes: Number(d.retentionGb) * 1024 ** 3 } : {}) } as never)],
    ["Automatic removal", d.priority === "P1" ? "Never (Protected)" : d.automaticEviction ? "Allowed when space runs short" : "Not allowed"],
  ];
  void edit;
  return (
    <dl className="divide-y rounded-lg border px-4" data-testid="review-summary">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
          <dt className="w-40 shrink-0 text-sm text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words text-sm">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Create (a four-step wizard) or edit (one page) a source. Both share the same sections and the same validation.
 * Server field errors use the paths of docs/api.md (`config.maxPages`, `startUrl`), and land on the matching field.
 */
export function SourceForm({ source }: { source?: Source }) {
  const router = useRouter();
  const { toast } = useToast();
  const edit = !!source;
  const restricted = !!source?.system;
  const cols = useCollections();
  const setup = useApi<SetupStatus>("/api/setup/status");
  const [d, setD] = React.useState<Draft>(() => (source ? draftFromSource(source) : emptyDraft()));
  const [step, setStep] = React.useState(0);
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({});
  const [showClient, setShowClient] = React.useState(false);
  const [general, setGeneral] = React.useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<{ data: SourcePreview | null; loading: boolean; error: string | null }>({ data: null, loading: false, error: null });
  const [ceilFromPreview, setCeil] = React.useState<SourceCeilings | null>(null);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [focusTick, setFocusTick] = React.useState(0);
  const importing = d.type === "imported_documents";
  const stepNames = importing ? IMPORT_STEPS : STEPS;
  const limits = useImportLimits();
  const queue = useImportQueue(limits.data);
  const allSources = useSources();
  const importSources = allSources.sources.filter((x) => x.type === "imported_documents");
  /** "new" creates a source from the wizard; otherwise the id of an imported-documents source to add to. */
  const [importTarget, setImportTarget] = React.useState("new");
  const [createdId, setCreatedId] = React.useState<string | null>(null);

  const profile = setup.data?.profile ?? null;
  const ceil = ceilFromPreview ?? (profile ? CEILINGS[profile] : null);
  const clientErrors = React.useMemo(() => (showClient ? validateDraft(d, ceil, edit) : {}), [d, ceil, edit, showClient]);
  const errors = { ...clientErrors, ...serverErrors };

  function set(patchD: Partial<Draft>) {
    setD((cur) => ({ ...cur, ...patchD }));
    setServerErrors((e) => (Object.keys(e).length ? {} : e));
  }

  React.useEffect(() => {
    if (focusTick) summaryRef.current?.focus();
  }, [focusTick]);
  React.useEffect(() => {
    if (step > 0) headingRef.current?.focus();
  }, [step]);

  const web = isWebType(d.type);
  const crawl = CRAWL_TYPES.includes(d.type as never);
  const summaryItems = Object.entries(errors).map(([k, message]) => ({ id: fid(k), message }));

  function failWith(errs: Record<string, string>, general?: string) {
    setServerErrors(errs);
    setShowClient(true);
    setGeneral(general ?? null);
    const keys = Object.keys(errs);
    if (keys.some(isScopeAdvanced)) setScopeOpen(true);
    if (keys.some(isMoreAdvanced)) setMoreOpen(true);
    if (!edit && keys.length) setStep(Math.min(...keys.map(stepOfKey)));
    setFocusTick((t) => t + 1);
  }

  function keysForStep(s: number, errs: Record<string, string>) {
    return Object.keys(errs).filter((k) => stepOfKey(k) === s);
  }

  function next() {
    setShowClient(true);
    const errs = validateDraft(d, ceil, edit);
    const mine = Object.fromEntries(Object.entries(errs).filter(([k]) => keysForStep(step, errs).includes(k)));
    if (Object.keys(mine).length) {
      if (Object.keys(mine).some(isScopeAdvanced)) setScopeOpen(true);
      if (Object.keys(mine).some(isMoreAdvanced)) setMoreOpen(true);
      setFocusTick((t) => t + 1);
      return;
    }
    setGeneral(null);
    setShowClient(false);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  const runPreview = React.useCallback(async () => {
    const errs = validateDraft(d, ceil, edit);
    if (Object.keys(errs).length) {
      failWith(errs);
      return;
    }
    setPreview({ data: null, loading: true, error: null });
    try {
      const p = await post<SourcePreview>("/api/sources/preview", buildInput(d, edit));
      setPreview({ data: p, loading: false, error: null });
      if (p.ceilings) setCeil(p.ceilings);
    } catch (e) {
      const fe = fieldErrors(e);
      setPreview({ data: null, loading: false, error: Object.keys(fe).length ? "The preview found problems with these settings. They are listed above." : errorMessage(e) });
      if (Object.keys(fe).length) failWith(fe);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, ceil, edit]);

  // The preview runs when the review step opens, so the estimate is always in front of the Human before the first run.
  const lastStep = !edit && step === STEPS.length - 1;
  React.useEffect(() => {
    if (lastStep && !importing && !preview.data && !preview.loading && !preview.error) void runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStep]);
  React.useEffect(() => {
    // Any change after a preview makes it stale.
    setPreview((p) => (p.data || p.error ? { data: null, loading: false, error: null } : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);

  async function saveSchedule(src: Source) {
    if (restricted) return;
    const wantWindow = d.schedKind !== "manual" && d.windowOn;
    const base = buildSchedule(d);
    if (!src.schedule) {
      if (d.schedKind === "manual") return;
      const created = await post<{ id: string }>("/api/schedules", { sourceId: src.id, ...base, ...(wantWindow ? { window: buildWindow(d) } : {}) });
      void created;
      return;
    }
    await patch(`/api/schedules/${src.schedule.id}`, { ...base, ...(wantWindow ? { window: buildWindow(d) } : { windowId: null }) });
  }

  async function submit(runNow: boolean) {
    setShowClient(true);
    const errs = validateDraft(d, ceil, edit);
    if (Object.keys(errs).length) {
      failWith(errs);
      return;
    }
    setBusy(true);
    setGeneral(null);
    try {
      const input = buildInput(d, edit);
      let saved: Source;
      if (edit) {
        const body = restricted
          ? { priority: input.priority, retention: input.retention, automaticEviction: input.automaticEviction, enabled: input.enabled }
          : { ...input, type: undefined, description: d.description.trim() || null, storageBudgetBytes: d.budgetGb.trim() ? input.storageBudgetBytes : null };
        saved = await patch<Source>(`/api/sources/${source!.id}`, body);
        await saveSchedule(saved);
      } else {
        // The schedule and its download window go in the same request as the source.
        saved = await post<Source>("/api/sources", {
          ...input,
          ...(d.schedKind !== "manual" ? { schedule: { ...buildSchedule(d), ...(d.windowOn ? { window: buildWindow(d) } : {}) } } : {}),
        });
      }
      toast({ title: edit ? "Changes saved" : "Source created", description: saved.name, variant: "success" });
      if (runNow) {
        try {
          const r = await post<RunResult>(`/api/sources/${saved.id}/run`);
          toast({ title: `${saved.name} is running`, description: `${r.downloadIds?.length ?? 0} downloads started. Follow them on the Downloads screen.`, variant: "success" });
        } catch (e) {
          toast({ title: "The source was created but could not start", description: errorMessage(e), variant: "error" });
        }
      }
      router.push(`/library/sources/${saved.id}`);
    } catch (e) {
      const fe = fieldErrors(e);
      failWith(fe, Object.keys(fe).length ? undefined : errorMessage(e instanceof ApiError ? e : e));
    } finally {
      setBusy(false);
    }
  }

  /** Creates the source (once), then sends the chosen files one by one. Failed files stay in the list to retry. */
  async function submitImport() {
    setShowClient(true);
    const errs = importTarget === "new" ? validateDraft(d, ceil, false) : {};
    if (Object.keys(errs).length) {
      failWith(errs);
      return;
    }
    setBusy(true);
    setGeneral(null);
    try {
      let sid = importTarget === "new" ? createdId : importTarget;
      if (!sid) {
        const saved = await post<Source>("/api/sources", buildInput(d, false));
        sid = saved.id;
        setCreatedId(saved.id);
        toast({ title: "Source created", description: saved.name, variant: "success" });
      }
      const { uploaded, failed } = queue.queued > 0 ? await queue.start(sid) : { uploaded: 0, failed: queue.failed };
      if (failed > 0) {
        setGeneral(`${failed} ${failed === 1 ? "file" : "files"} could not be imported. Fix or remove ${failed === 1 ? "it" : "them"}, or retry.`);
        return;
      }
      if (uploaded > 0) toast({ title: `${uploaded} ${uploaded === 1 ? "file" : "files"} imported`, variant: "success" });
      router.push(`/library/sources/${sid}`);
    } catch (e) {
      const fe = fieldErrors(e);
      failWith(fe, Object.keys(fe).length ? undefined : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const sectionProps = { d, set, errors, ceil };
  const summary = <ErrorSummary ref={summaryRef} items={summaryItems} />;

  // ---- edit: every section on one page ----
  if (edit) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); void submit(false); }} noValidate className="space-y-6" data-testid="source-form">
        {summary}
        {general ? <FormError message={general} /> : null}
        {!restricted ? (
          <FormSection title="Address and scope">
            <AddressSection {...sectionProps} advancedOpen={scopeOpen} onAdvancedOpen={setScopeOpen} />
          </FormSection>
        ) : null}
        {!restricted ? (
          <FormSection title="Schedule">
            <ScheduleSection {...sectionProps} />
          </FormSection>
        ) : null}
        <FormSection title="Priority and keeping">
          <KeepSection {...sectionProps} collections={cols.flat} hideCollections={restricted} />
        </FormSection>
        {!restricted ? <MoreAdvanced {...sectionProps} open={moreOpen} onOpenChange={setMoreOpen} web={web} crawl={crawl} /> : null}
        <FormSection title="Preview the changes">
          <p className="text-sm text-muted-foreground">Check what the source would save with these settings, before you save them.</p>
          <div><Button variant="outline" onClick={() => void runPreview()} disabled={preview.loading}><Eye aria-hidden="true" /> Preview</Button></div>
          {preview.data || preview.loading || preview.error ? <PreviewPanel preview={preview.data} loading={preview.loading} error={preview.error} /> : null}
        </FormSection>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy} data-testid="save-source"><Check aria-hidden="true" /> Save changes</Button>
          <Button variant="outline" onClick={() => router.push(`/library/sources/${source!.id}`)}>Cancel</Button>
        </div>
      </form>
    );
  }

  // ---- create: the wizard ----
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!lastStep) next(); }} noValidate className="space-y-6" data-testid="source-wizard">
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Steps">
        {stepNames.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={i === step ? "font-semibold" : "text-muted-foreground"}>
            {i + 1}. {s}{i < step ? <span className="sr-only"> (done)</span> : null}
          </li>
        ))}
      </ol>
      {summary}
      {general ? <FormError message={general} /> : null}
      <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none" data-testid="step-heading">
        Step {step + 1} of {stepNames.length}: {stepNames[step]}
      </h2>

      {step === 0 ? <TypeSection {...sectionProps} /> : null}
      {step === 1 ? <AddressSection {...sectionProps} advancedOpen={scopeOpen} onAdvancedOpen={setScopeOpen} /> : null}
      {step === 2 ? (
        <>
          {importing ? null : <FormSection title="Schedule"><ScheduleSection {...sectionProps} /></FormSection>}
          <FormSection title="Priority and keeping"><KeepSection {...sectionProps} collections={cols.flat} /></FormSection>
          {importing ? null : <MoreAdvanced {...sectionProps} open={moreOpen} onOpenChange={setMoreOpen} web={web} crawl={crawl} />}
        </>
      ) : null}
      {step === 3 && importing ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="import-target">Where should the files go?</Label>
            <Select id="import-target" value={importTarget} onChange={(e) => setImportTarget(e.target.value)} disabled={busy || !!createdId} data-testid="import-target">
              <option value="new">A new source called “{d.name.trim() || "…"}”</option>
              {importSources.map((x) => <option key={x.id} value={x.id}>{x.system ? `${x.name} (built in)` : x.name}</option>)}
            </Select>
          </div>
          <ImportDropzone queue={queue} limits={limits.data} disabled={busy} />
        </>
      ) : null}
      {step === 3 && !importing ? (
        <>
          <Summary d={d} edit={false} />
          <PreviewPanel preview={preview.data} loading={preview.loading} error={preview.error} />
          <div><Button variant="outline" onClick={() => void runPreview()} disabled={preview.loading} data-testid="preview-again"><Eye aria-hidden="true" /> Check again</Button></div>
        </>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t pt-4">
        {step > 0 ? <Button variant="outline" onClick={() => { setShowClient(false); setStep((s) => s - 1); }}><ArrowLeft aria-hidden="true" /> Back</Button> : null}
        {!lastStep ? (
          <Button type="submit" data-testid="wizard-next">Next <ArrowRight aria-hidden="true" /></Button>
        ) : importing ? (
          <Button onClick={() => void submitImport()} disabled={busy || queue.running} data-testid="create-and-upload">
            <Upload aria-hidden="true" />{" "}
            {queue.queued > 0 ? `${importTarget === "new" && !createdId ? "Create source and upload" : "Upload"} ${queue.queued} ${queue.queued === 1 ? "file" : "files"}` : importTarget === "new" && !createdId ? "Create source" : "Done"}
          </Button>
        ) : (
          <>
            <Button onClick={() => void submit(true)} disabled={busy || preview.loading || !d.enabled} data-testid="create-and-run"><Play aria-hidden="true" /> Create and run now</Button>
            <Button variant="outline" onClick={() => void submit(false)} disabled={busy || preview.loading} data-testid="create-source"><Check aria-hidden="true" /> Create source</Button>
          </>
        )}
        <Button variant="ghost" onClick={() => router.push("/library/sources")}>Cancel</Button>
      </div>
    </form>
  );
}

void put;
