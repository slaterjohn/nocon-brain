"use client";

import * as React from "react";
import { DatabaseBackup, ScanSearch, Wrench } from "lucide-react";
import { errorMessage, post, get, useApi } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { maintenanceHeadline, type MaintenanceListItem, type MaintenanceRun } from "@/lib/storage";
import { formatBytes, formatDate } from "@/lib/utils";
import { ConfirmDialog, Notice } from "./shared";

export const CHECKS: { id: string; label: string }[] = [
  { id: "I-1", label: "Every stored file is there and the right size" },
  { id: "I-2", label: "Every file on a volume has a record" },
  { id: "I-3", label: "Use counts add up" },
  { id: "I-4", label: "No record points at something missing" },
  { id: "I-5", label: "No saved copy is stuck half-finished" },
  { id: "I-6", label: "Each page points at a usable copy" },
  { id: "I-7", label: "Per-site download counters are right" },
  { id: "I-8", label: "No room is held for a finished download" },
  { id: "I-9", label: "No old temporary files" },
  { id: "I-10", label: "The search index matches the archive" },
  { id: "I-11", label: "A sample of files matches their checksums" },
  { id: "I-12", label: "The database passes its own check" },
  { id: "I-13", label: "No Protected copy was removed" },
  { id: "REF", label: "Pages that nothing keeps" },
];

const KIND_TEXT: Record<MaintenanceRun["kind"], string> = { verify: "Check", repair: "Repair", integrity_check: "Database check", scrub: "Checksum scrub" };

export function ReportView({ run }: { run: MaintenanceRun }) {
  return (
    <div className="space-y-4" data-testid="maintenance-report">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={run.dryRun ? "secondary" : "warning"} data-testid="report-mode">{run.dryRun ? "Dry run: nothing was changed" : "Repair run"}</Badge>
        <Badge variant={run.state === "done" ? "success" : run.state === "failed" ? "destructive" : "secondary"}>{run.state === "done" ? "Finished" : run.state === "failed" ? "Failed" : "Running"}</Badge>
        <span className="text-xs text-muted-foreground">{formatDate(run.startedAt)}</span>
      </div>
      <p className="text-base font-medium" data-testid="report-headline">{maintenanceHeadline(run)}</p>
      {run.findings.length > 0 ? (
        <Table aria-label="Findings">
          <caption className="sr-only">Problems found, by check</caption>
          <TableHeader><TableRow><TableHead>Check</TableHead><TableHead>What was found</TableHead><TableHead className="text-right">Count</TableHead>{run.dryRun ? null : <TableHead className="text-right">Repaired</TableHead>}</TableRow></TableHeader>
          <TableBody>
            {run.findings.map((f) => (
              <TableRow key={f.invariant} data-testid="finding">
                <TableCell className="whitespace-nowrap font-medium">{f.invariant}</TableCell>
                <TableCell>
                  <p>{f.title}</p>
                  {f.note ? <p className="text-xs text-muted-foreground">{f.note}</p> : null}
                  {f.examples.length ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground">Examples</summary>
                      <ul className="mt-1 list-disc pl-5 text-xs break-all text-muted-foreground">{f.examples.map((x) => <li key={x}>{x}</li>)}</ul>
                    </details>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{f.count.toLocaleString("en-GB")}</TableCell>
                {run.dryRun ? null : <TableCell className="text-right tabular-nums">{(f.repaired ?? 0).toLocaleString("en-GB")}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {Object.keys(run.checked).length > 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="report-checked">
          Looked at: {Object.entries(run.checked).map(([k, n]) => `${n.toLocaleString("en-GB")} ${k}`).join(", ")}.
        </p>
      ) : null}
      {run.skipped.length > 0 ? (
        <div>
          <p className="text-sm font-medium">Not checked</p>
          <ul className="list-disc pl-5 text-sm text-muted-foreground">{run.skipped.map((s) => <li key={s.invariant}>{s.invariant}: {s.reason}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

export function MaintenanceView() {
  const runs = useApi<{ items: MaintenanceListItem[] }>("/api/system/maintenance/runs?limit=20");
  const { toast } = useToast();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [advOpen, setAdvOpen] = React.useState(false);
  const [report, setReport] = React.useState<MaintenanceRun | null>(null);
  const [busy, setBusy] = React.useState<"verify" | "repair" | "backup" | "open" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const [backup, setBackup] = React.useState<{ file: string; sizeBytes: number } | null>(null);
  const reportRef = React.useRef<HTMLDivElement>(null);

  async function runCheck(repair: boolean) {
    setBusy(repair ? "repair" : "verify"); setError(null);
    try {
      const r = await post<MaintenanceRun>("/api/system/maintenance/verify", { repair, ...(selected.length ? { checks: selected } : {}) });
      setReport(r);
      setConfirm(false);
      await runs.mutate();
      setTimeout(() => reportRef.current?.focus(), 50);
    } catch (e) {
      setError(errorMessage(e));
      setConfirm(false);
    } finally {
      setBusy(null);
    }
  }

  async function open(id: string) {
    setBusy("open"); setError(null);
    try {
      setReport(await get<MaintenanceRun>(`/api/system/maintenance/runs/${id}`));
      setTimeout(() => reportRef.current?.focus(), 50);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function makeBackup() {
    setBusy("backup"); setError(null);
    try {
      const b = await post<{ file: string; sizeBytes: number }>("/api/system/maintenance/backup");
      setBackup(b);
      toast({ title: "Backup written", description: b.file, variant: "success" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const canRepair = report !== null && report.dryRun && report.findings.some((f) => f.count > 0 && f.invariant !== "I-12" && f.invariant !== "I-13" && f.invariant !== "REF");

  return (
    <>
      <PageHeader title="Check and repair" description="Look for storage problems such as missing files, wrong counts or a stale search index. A check reports only. Nothing is changed until a repair is confirmed." />
      <div className="space-y-8">
        <section aria-labelledby="check-h" className="space-y-3">
          <h2 id="check-h" className="text-lg font-semibold">Check storage</h2>
          <AdvancedSettings open={advOpen} onOpenChange={setAdvOpen} title="Advanced settings: choose checks" changed={selected.length ? 1 : 0} id="mt-adv">
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm text-muted-foreground">Leave all unticked to run every check.</legend>
              {CHECKS.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <Checkbox id={`chk-${c.id}`} checked={selected.includes(c.id)} onCheckedChange={(v) => setSelected((s) => (v === true ? [...s, c.id] : s.filter((x) => x !== c.id)))} />
                  <Label htmlFor={`chk-${c.id}`} className="font-normal"><span className="font-medium">{c.id}</span> {c.label}</Label>
                </div>
              ))}
            </fieldset>
          </AdvancedSettings>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void runCheck(false)} disabled={busy !== null} data-testid="verify-run"><ScanSearch aria-hidden="true" /> {busy === "verify" ? "Checking…" : "Check storage (dry run)"}</Button>
            {canRepair ? <Button variant="outline" onClick={() => setConfirm(true)} disabled={busy !== null} data-testid="repair-open"><Wrench aria-hidden="true" /> Repair what was found…</Button> : null}
          </div>
          <p className="text-sm text-muted-foreground">A dry run is the default. It reads the archive and reports. It never changes it.</p>
          {error ? <ErrorState title="That didn't work" message={error} /> : null}
          <div ref={reportRef} tabIndex={-1} className="outline-none" aria-live="polite">{report ? <ReportView run={report} /> : null}</div>
        </section>

        <section aria-labelledby="runs-h" className="space-y-2" data-testid="maintenance-runs">
          <h2 id="runs-h" className="text-lg font-semibold">Earlier runs</h2>
          {runs.error && !runs.data ? <ErrorState title="Couldn't load the runs" message={runs.error.message} onRetry={() => void runs.mutate()} /> : null}
          {!runs.data && !runs.error ? <LoadingSkeleton rows={3} label="Loading earlier runs" /> : null}
          {runs.data && runs.data.items.length === 0 ? <p className="text-sm text-muted-foreground">No check has been run yet.</p> : null}
          {runs.data && runs.data.items.length > 0 ? (
            <Table aria-label="Maintenance runs">
              <caption className="sr-only">Earlier checks and repairs, newest first</caption>
              <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Kind</TableHead><TableHead>Mode</TableHead><TableHead>State</TableHead><TableHead><span className="sr-only">Report</span></TableHead></TableRow></TableHeader>
              <TableBody>
                {runs.data.items.map((r) => (
                  <TableRow key={r.id} data-testid="maintenance-run">
                    <TableCell>{formatDate(r.startedAt)}</TableCell>
                    <TableCell>{KIND_TEXT[r.kind]}</TableCell>
                    <TableCell>{r.dryRun ? "Dry run" : "Changes made"}</TableCell>
                    <TableCell>{r.state === "done" ? "Finished" : r.state === "failed" ? "Failed" : "Running"}</TableCell>
                    <TableCell><Button size="sm" variant="outline" onClick={() => void open(r.id)} disabled={busy !== null}>View report<span className="sr-only"> from {formatDate(r.startedAt)}</span></Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </section>

        <section aria-labelledby="bk-h" className="space-y-2">
          <h2 id="bk-h" className="text-lg font-semibold">Database backup</h2>
          <p className="text-sm text-muted-foreground">Writes a copy of the database to the data folder. Saved page files are not copied.</p>
          <Button variant="outline" onClick={() => void makeBackup()} disabled={busy !== null} data-testid="backup-run"><DatabaseBackup aria-hidden="true" /> {busy === "backup" ? "Writing…" : "Back up the database"}</Button>
          <p role="status" className="text-sm" data-testid="backup-result">{backup ? `Written: ${backup.file} (${formatBytes(backup.sizeBytes)}).` : ""}</p>
        </section>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Repair what was found?"
        description={
          <>
            <p>Each problem found is fixed: wrong counts are recounted, records of missing files are marked missing, and stuck copies are closed.</p>
            <p data-testid="repair-quarantine-note"><strong>Nothing is deleted without a way back.</strong> Files that have no record, and files whose checksum does not match, are moved to a quarantine folder on their volume. They are quarantined, not deleted, so they can be put back or removed by hand later.</p>
            <p>Take a database backup first if you want a restore point.</p>
          </>
        }
        confirmLabel="Repair now"
        busy={busy === "repair"}
        onConfirm={() => void runCheck(true)}
        testId="repair"
      />
      {report && !report.dryRun ? <Notice testId="repair-done">Repairs are recorded in the activity log.</Notice> : null}
    </>
  );
}
