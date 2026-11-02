"use client";

import * as React from "react";
import Link from "next/link";
import { OctagonX, Play } from "lucide-react";
import { errorMessage, get, post, useApi } from "@/lib/api";
import {
  RUNNER_BLOCK_WORDS, bytesText, passLaneSummary, percentUsed, requestsText, runnerHeadline,
  type Budget, type LaneBudget, type LedgerEntry, type PassReport, type RunnerStatus,
} from "@/lib/discovery";
import { formatBytes, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { ConfirmDialog, Notice } from "@/components/storage/shared";
import { POLL_BUSY_MS, POLL_IDLE_MS, RunPassButton, useRunner } from "./hooks";

/** A meter with its text equivalent beside it. The bar is for sighted users; the sentence says the same thing. */
export function Meter({ id, label, used, limit, text }: { id: string; label: string; used: number; limit: number; text: string }) {
  return (
    <div className="space-y-1" data-testid={`meter-${id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm tabular-nums" data-testid={`meter-${id}-text`}>{text}</span>
      </div>
      <Progress value={percentUsed(used, limit)} label={`${label}: ${text}`} />
    </div>
  );
}

function LaneMeters({ idPrefix, lane }: { idPrefix: string; lane: LaneBudget }) {
  return (
    <div className="space-y-4">
      <Meter id={`${idPrefix}-requests`} label="Requests today" used={lane.requests.used} limit={lane.requests.limit} text={requestsText(lane.requests.used, lane.requests.limit)} />
      <Meter id={`${idPrefix}-bytes`} label="Data today" used={lane.bytes.used} limit={lane.bytes.limit} text={bytesText(lane.bytes.used, lane.bytes.limit, (n) => formatBytes(n))} />
    </div>
  );
}

function BudgetPanel({ budget }: { budget: Budget }) {
  return (
    <section aria-labelledby="budget-h" className="space-y-4" data-testid="budget-panel">
      <div>
        <h2 id="budget-h" className="text-lg font-semibold">Budget</h2>
        <p className="text-sm text-muted-foreground">
          A request is one page with its images and styles (at most 40 files). The day is a UTC day and the budgets reset at {formatDate(budget.resetsAt)}. Every meter has its figures in words beside it.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Active runner</CardTitle>
            <CardDescription>Pages from links, visits, bookmarks, missing links and saved searches.</CardDescription>
          </CardHeader>
          <CardContent><LaneMeters idPrefix="active" lane={budget.active} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Background</CardTitle>
            <CardDescription>Search-driven downloads and pages kept from web search. One budget for both.</CardDescription>
          </CardHeader>
          <CardContent><LaneMeters idPrefix="background" lane={budget.background} /></CardContent>
        </Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Queue and pool</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Meter id="queue" label="Discovery downloads waiting or running" used={budget.queue.inFlight} limit={budget.queue.limit} text={`${budget.queue.inFlight.toLocaleString("en-GB")} of ${budget.queue.limit.toLocaleString("en-GB")} at once`} />
            <Meter id="pool" label="Suggestions kept" used={budget.pool.candidates} limit={budget.pool.limit} text={`${budget.pool.candidates.toLocaleString("en-GB")} of ${budget.pool.limit.toLocaleString("en-GB")} kept`} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>This month</CardTitle><CardDescription>Everything discovery has downloaded this calendar month. There is no limit on this figure.</CardDescription></CardHeader>
          <CardContent>
            <p className="text-sm" data-testid="month-total">
              {budget.month.requests.toLocaleString("en-GB")} {budget.month.requests === 1 ? "request" : "requests"}, {formatBytes(budget.month.bytes)} downloaded.
            </p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Busiest sites today</CardTitle>
          <CardDescription>No more than {budget.perSite.cap.toLocaleString("en-GB")} {budget.perSite.cap === 1 ? "download" : "downloads"} from one site in a day.</CardDescription>
        </CardHeader>
        <CardContent>
          {budget.perSite.top.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="per-site-empty">No site has been used today.</p>
          ) : (
            <Table aria-label="Busiest sites today" data-testid="per-site-table">
              <caption className="sr-only">Requests made to each site today, against a limit of {budget.perSite.cap}.</caption>
              <TableHeader><TableRow><TableHead>Site</TableHead><TableHead className="text-right">Requests today</TableHead><TableHead className="min-w-40">Against the limit of {budget.perSite.cap}</TableHead></TableRow></TableHeader>
              <TableBody>
                {budget.perSite.top.map((s) => (
                  <TableRow key={s.host} data-testid="per-site-row">
                    <TableCell className="break-all">{s.host}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.requests.toLocaleString("en-GB")}</TableCell>
                    <TableCell><Progress value={percentUsed(s.requests, budget.perSite.cap)} label={`${s.host}: ${s.requests} of ${budget.perSite.cap}`} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function PassLines({ pass }: { pass: PassReport }) {
  return (
    <div className="space-y-1 text-sm" data-testid="last-pass">
      <p>
        Last pass: {formatDate(pass.at)} ({pass.trigger === "manual" ? "started by you" : "on the timer"}).
      </p>
      <ul className="list-disc space-y-0.5 pl-5">
        <li data-testid="pass-active">{passLaneSummary("Active runner", pass.active)}</li>
        <li data-testid="pass-background">{passLaneSummary("Background", pass.background)}</li>
      </ul>
    </div>
  );
}

function RunnerPanel({ runner, onChanged, onRunning }: { runner: RunnerStatus; onChanged: () => void; onRunning: (r: boolean) => void }) {
  const { toast } = useToast();
  const [confirm, setConfirm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const paused = runner.killSwitch.paused;
  const badge = runner.state === "idle" ? { text: "Ready", v: "success" as const } : runner.state === "blocked" ? { text: "Held back", v: "warning" as const } : runner.state === "paused" ? { text: "Paused", v: "destructive" as const } : { text: "Off", v: "secondary" as const };

  async function pause() {
    setBusy(true);
    try {
      const r = await post<{ paused: boolean; cancelled: number }>("/api/discovery/pause");
      toast({ title: "Discovery paused", description: r.cancelled ? `${r.cancelled} waiting ${r.cancelled === 1 ? "download was" : "downloads were"} cancelled.` : "No discovery download will start." });
      setConfirm(false);
      onChanged();
    } catch (e) {
      toast({ title: "Couldn't pause discovery", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function resume() {
    setBusy(true);
    try {
      await post("/api/discovery/resume");
      toast({ title: "Discovery resumed", description: "Downloads may start again, within the limits." });
      onChanged();
    } catch (e) {
      toast({ title: "Couldn't resume discovery", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="runner-h" className="space-y-4" data-testid="runner-panel">
      <h2 id="runner-h" className="text-lg font-semibold">Runner</h2>
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant={badge.v} data-testid="runner-state">{badge.text}</Badge>
            <span data-testid="runner-headline">{runnerHeadline(runner)}</span>
          </p>
          {runner.blockedBy.length ? (
            <ul className="list-disc space-y-0.5 pl-5 text-sm" data-testid="runner-blockers">
              {runner.blockedBy.map((b) => <li key={b} data-blocker={b}>{RUNNER_BLOCK_WORDS[b]}</li>)}
            </ul>
          ) : null}
          <p className="text-sm text-muted-foreground" data-testid="runner-inflight">
            {runner.inFlight} discovery {runner.inFlight === 1 ? "download is" : "downloads are"} waiting or running.{" "}
            <Link href="/downloads" className="underline underline-offset-2">Open Downloads</Link>
          </p>
          {runner.lastPass ? <PassLines pass={runner.lastPass} /> : <p className="text-sm text-muted-foreground" data-testid="no-pass">No pass has run since the server started.</p>}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <RunPassButton onRunning={onRunning} onDone={onChanged} variant="outline" />
            <span className="text-xs text-muted-foreground">One pass, obeying every limit. Useful for trying out settings.</span>
          </div>
        </CardContent>
      </Card>

      <Card className={paused ? "border-destructive/60" : undefined}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><OctagonX className="size-4" aria-hidden="true" /> Kill switch</CardTitle>
          <CardDescription>
            Stops every discovery download at once: the active runner, the background lane and the auto-cache. Downloads still waiting are cancelled; one that is already running finishes. It stays on after a restart.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <p className="text-sm" role="status" data-testid="kill-state">
            {paused ? <>Discovery is <strong>paused</strong>{runner.killSwitch.since ? ` since ${formatDate(runner.killSwitch.since)}` : ""}.</> : <>Discovery is <strong>not paused</strong>.</>}
          </p>
          {paused ? (
            <Button onClick={() => void resume()} disabled={busy} data-testid="kill-resume"><Play aria-hidden="true" /> Resume discovery</Button>
          ) : (
            <Button variant="destructive" onClick={() => setConfirm(true)} disabled={busy} data-testid="kill-pause"><OctagonX aria-hidden="true" /> Pause discovery</Button>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Pause discovery?"
        confirmLabel="Pause discovery"
        destructive
        busy={busy}
        onConfirm={() => void pause()}
        testId="pause"
        description={
          <>
            <p>No discovery download will start until you resume. Downloads that are still waiting are cancelled. A download that is already running finishes.</p>
            <p>This covers both lanes and the auto-cache. Suggestions are still collected, and pages you save yourself are not affected.</p>
          </>
        }
      />
    </section>
  );
}

const LANE_LABEL: Record<LedgerEntry["lane"], string> = { active: "Active runner", background: "Background", auto_cache: "Auto-cache" };
const OUTCOME_LABEL: Record<NonNullable<LedgerEntry["outcome"]>, string> = { archived: "Saved", unchanged: "Unchanged", failed: "Failed", cancelled: "Cancelled" };

function Ledger() {
  const [lane, setLane] = React.useState("");
  const [items, setItems] = React.useState<LedgerEntry[]>([]);
  const [next, setNext] = React.useState<string | undefined>();
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState("");
  const [more, setMore] = React.useState(false);

  const load = React.useCallback(async (cursor?: string) => {
    const p = new URLSearchParams({ limit: "25" });
    if (lane) p.set("lane", lane);
    if (cursor) p.set("cursor", cursor);
    try {
      const r = await get<{ items: LedgerEntry[]; nextCursor?: string }>(`/api/discovery/ledger?${p.toString()}`);
      setItems((cur) => (cursor ? [...cur, ...r.items] : r.items));
      setNext(r.nextCursor);
      setState("ready");
    } catch (e) {
      setError(errorMessage(e));
      setState("error");
    }
  }, [lane]);

  React.useEffect(() => {
    setState("loading");
    void load();
  }, [load]);

  return (
    <section aria-labelledby="ledger-h" className="space-y-3" data-testid="ledger">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="ledger-h" className="text-lg font-semibold">Ledger</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Before each download starts, discovery sets aside an allowance of data. The download cannot take more than that. When it ends, the entry shows what it really used. Entries are kept for 90 days.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="ledger-lane">Show</Label>
          <Select id="ledger-lane" value={lane} onChange={(e) => setLane(e.target.value)} className="w-48">
            <option value="">All lanes</option>
            <option value="active">Active runner</option>
            <option value="background">Background</option>
            <option value="auto_cache">Auto-cache</option>
          </Select>
        </div>
      </div>
      {state === "loading" ? <LoadingSkeleton rows={3} label="Loading the ledger" /> : null}
      {state === "error" ? <ErrorState title="Couldn't load the ledger" message={error} onRetry={() => void load()} /> : null}
      {state === "ready" && items.length === 0 ? (
        <EmptyState title="Nothing in the ledger yet" description="An entry appears when discovery starts a download or keeps a page you opened." />
      ) : null}
      {state === "ready" && items.length > 0 ? (
        <>
          <Table aria-label="Ledger">
            <caption className="sr-only">Discovery downloads, newest first.</caption>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead><TableHead>Lane</TableHead><TableHead>Site</TableHead>
                <TableHead className="text-right">Requests</TableHead><TableHead className="text-right">Set aside</TableHead><TableHead className="text-right">Used</TableHead><TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((e) => (
                <TableRow key={e.id} data-testid="ledger-row" data-outcome={e.outcome ?? "reserved"}>
                  <TableCell className="whitespace-nowrap">{formatDate(e.at)}</TableCell>
                  <TableCell>{LANE_LABEL[e.lane]}</TableCell>
                  <TableCell className="break-all">{e.host}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.requests}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(e.reservedBytes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.state === "settled" ? formatBytes(e.bytes ?? 0) : "not yet"}</TableCell>
                  <TableCell>{e.state === "reserved" ? "In progress" : e.outcome ? OUTCOME_LABEL[e.outcome] : "Done"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {next ? (
            <Button
              variant="outline"
              disabled={more}
              onClick={async () => {
                setMore(true);
                await load(next);
                setMore(false);
              }}
              data-testid="ledger-more"
            >
              {more ? "Loading…" : "Show more entries"}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function BudgetView() {
  const [passRunning, setPassRunning] = React.useState(false);
  const runner = useRunner(passRunning);
  const budget = useApi<Budget>("/api/discovery/budget", { refreshInterval: passRunning || (runner.data?.inFlight ?? 0) > 0 ? POLL_BUSY_MS : POLL_IDLE_MS });
  const changed = () => {
    void runner.mutate();
    void budget.mutate();
  };
  const failed = runner.error ?? budget.error;
  return (
    <>
      <PageHeader
        title="Budget and runner"
        description="What discovery has used today, whether it can run now, and the kill switch. Everything here is read from the server; nothing is guessed."
        actions={<Link href="/discovery/settings" className="text-sm text-primary underline underline-offset-2">Change the limits</Link>}
      />
      {failed && !runner.data ? (
        <ErrorState title="Couldn't load discovery" message={failed.message} onRetry={changed} />
      ) : !runner.data || !budget.data ? (
        <LoadingSkeleton variant="page" label="Loading discovery" />
      ) : (
        <div className="space-y-8">
          {runner.data.state === "off" ? (
            <Notice title="Discovery is off">
              It is off until you switch it on, so nothing is collected or downloaded. <Link href="/discovery/settings" className="underline underline-offset-2">Open the settings</Link>.
            </Notice>
          ) : null}
          <RunnerPanel runner={runner.data} onChanged={changed} onRunning={setPassRunning} />
          <BudgetPanel budget={budget.data} />
          <Ledger />
        </div>
      )}
    </>
  );
}
