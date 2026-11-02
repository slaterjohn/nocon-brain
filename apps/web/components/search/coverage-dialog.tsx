"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, post } from "@/lib/api";
import { PRIORITIES } from "@/lib/library-copy";
import { formatBytes, formatDuration } from "@/lib/utils";
import type { Priority, RetentionSpec } from "@/lib/types";
import type { SearchResult } from "@/lib/search";

type Strategy = "capture" | "explore" | "mirror";
const STRATEGIES: { value: Strategy; label: string; text: string }[] = [
  { value: "capture", label: "Save these pages only", text: "One copy of each page you pick. Nothing it links to." },
  { value: "explore", label: "Save these pages and what they link to", text: "Follows links from each page, up to the depth you choose." },
  { value: "mirror", label: "Save the whole sites", text: "Follows links across the sites these pages are on. Can be large." },
];

interface Estimate {
  estimate: true;
  pages: { low: number; high: number };
  bytes: { low: number; high: number };
  durationSeconds: { low: number; high: number };
  basis: string;
  confidence: "low" | "medium" | "high";
}
interface Plan { planId: string; urls: number; estimate: Estimate; warnings: string[]; expiresAt: string }

const range = (a: number, b: number, f: (n: number) => string) => (a === b ? f(a) : `${f(a)} to ${f(b)}`);

/** "Improve offline coverage": pick uncached web results, choose how to save them, read the estimate, then queue. */
export function CoverageDialog({
  open, onOpenChange, searchId, candidates, onQueued,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  searchId: string;
  candidates: SearchResult[];
  onQueued: (keys: string[], info: { queued: number; collectionId?: string }) => void;
}) {
  const [step, setStep] = React.useState<"choose" | "review">("choose");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [strategy, setStrategy] = React.useState<Strategy>("capture");
  const [depth, setDepth] = React.useState("1");
  const [priority, setPriority] = React.useState<Priority>("P3");
  const [retention, setRetention] = React.useState<"all" | "latest" | "time">("all");
  const [retentionN, setRetentionN] = React.useState("3");
  const [asCollection, setAsCollection] = React.useState(false);
  const [collectionName, setCollectionName] = React.useState("");
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setStep("choose");
    setPicked(new Set(candidates.map((c) => c.key)));
    setPlan(null);
    setError("");
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const allPicked = candidates.length > 0 && candidates.every((c) => picked.has(c.key));
  const retentionSpec = (): RetentionSpec =>
    retention === "latest" ? { mode: "latest", count: Math.max(1, Number(retentionN) || 1) } : retention === "time" ? { mode: "time", days: Math.max(1, Number(retentionN) || 1), keepLatest: true } : { mode: "all" };

  async function estimate(e: React.FormEvent) {
    e.preventDefault();
    if (!picked.size) {
      setError("Pick at least one result.");
      return;
    }
    if (asCollection && !collectionName.trim()) {
      setError("Enter a name for the collection, or untick it.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = {
        searchId,
        resultKeys: allPicked ? "all_uncached" : [...picked],
        strategy,
        ...(strategy === "capture" ? {} : { depth: Math.min(3, Math.max(0, Number(depth) || 0)) }),
        priority,
        retention: retentionSpec(),
        ...(asCollection ? { asCollection: { name: collectionName.trim() } } : {}),
      };
      setPlan(await post<Plan>("/api/search/coverage/plan", body));
      setStep("review");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function queue() {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      const res = await post<{ queued: number; collectionId?: string }>("/api/search/coverage/queue", { planId: plan.planId });
      onQueued([...picked], res);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const est = plan?.estimate;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" aria-describedby="coverage-desc">
        <div>
          <DialogTitle>Improve offline coverage</DialogTitle>
          <DialogDescription id="coverage-desc" className="mt-1">
            Save web results so they can be read without internet. You see an estimate before anything is queued.
          </DialogDescription>
        </div>
        {error ? <p role="alert" className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-sm" data-testid="coverage-error">{error}</p> : null}
        {step === "choose" ? (
          <form onSubmit={estimate} className="space-y-5" noValidate>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">1. Results to save</legend>
              <div className="flex items-center gap-2">
                <Checkbox id="cov-all" checked={allPicked} onCheckedChange={(v) => setPicked(v === true ? new Set(candidates.map((c) => c.key)) : new Set())} />
                <Label htmlFor="cov-all" className="font-normal">All {candidates.length} not yet saved</Label>
              </div>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2" data-testid="coverage-candidates">
                {candidates.map((c) => (
                  <li key={c.key} className="flex items-start gap-2">
                    <Checkbox id={`cov-${c.key}`} checked={picked.has(c.key)} onCheckedChange={(v) => setPicked((p) => { const n = new Set(p); if (v === true) n.add(c.key); else n.delete(c.key); return n; })} />
                    <Label htmlFor={`cov-${c.key}`} className="min-w-0 font-normal">
                      <span className="block truncate">{c.title || c.url}</span>
                      <span className="block truncate text-xs text-muted-foreground">{c.domain}</span>
                    </Label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">2. How much to save</legend>
              {STRATEGIES.map((s) => (
                <div key={s.value} className="flex items-start gap-3 rounded-lg border p-3">
                  <input type="radio" id={`cov-s-${s.value}`} name="cov-strategy" className="mt-1 size-4 accent-[var(--primary)]" checked={strategy === s.value} onChange={() => setStrategy(s.value)} aria-describedby={`cov-s-${s.value}-d`} />
                  <div>
                    <Label htmlFor={`cov-s-${s.value}`}>{s.label}</Label>
                    <p id={`cov-s-${s.value}-d`} className="text-xs text-muted-foreground">{s.text}</p>
                  </div>
                </div>
              ))}
              {strategy !== "capture" ? (
                <div>
                  <Label htmlFor="cov-depth" className="mb-1 block">Links to follow (0 to 3)</Label>
                  <Input id="cov-depth" type="number" min={0} max={3} className="max-w-24" value={depth} onChange={(e) => setDepth(e.target.value)} />
                </div>
              ) : null}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">3. Priority</legend>
              <p className="text-xs text-muted-foreground">How much these pages matter when disk space runs short.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {PRIORITIES.map((p) => (
                  <div key={p.value} className="flex items-start gap-3 rounded-lg border p-3">
                    <input type="radio" id={`cov-p-${p.value}`} name="cov-priority" className="mt-1 size-4 accent-[var(--primary)]" checked={priority === p.value} onChange={() => setPriority(p.value)} aria-describedby={`cov-p-${p.value}-d`} />
                    <div>
                      <Label htmlFor={`cov-p-${p.value}`}>{p.label}</Label>
                      <p id={`cov-p-${p.value}-d`} className="text-xs text-muted-foreground">{p.explanation}</p>
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">4. Versions to keep</legend>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label htmlFor="cov-ret" className="mb-1 block">Keep</Label>
                  <Select id="cov-ret" value={retention} onChange={(e) => setRetention(e.target.value as typeof retention)}>
                    <option value="all">Every version</option>
                    <option value="latest">The latest few versions</option>
                    <option value="time">Versions from the last few days</option>
                  </Select>
                </div>
                {retention !== "all" ? (
                  <div>
                    <Label htmlFor="cov-ret-n" className="mb-1 block">{retention === "latest" ? "How many versions" : "How many days"}</Label>
                    <Input id="cov-ret-n" type="number" min={1} className="max-w-24" value={retentionN} onChange={(e) => setRetentionN(e.target.value)} />
                  </div>
                ) : null}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">5. Collection (optional)</legend>
              <div className="flex items-center gap-2">
                <Checkbox id="cov-col" checked={asCollection} onCheckedChange={(v) => setAsCollection(v === true)} />
                <Label htmlFor="cov-col" className="font-normal">Put the saved pages in a new collection</Label>
              </div>
              {asCollection ? (
                <div>
                  <Label htmlFor="cov-col-name" className="mb-1 block">Collection name</Label>
                  <Input id="cov-col-name" value={collectionName} onChange={(e) => setCollectionName(e.target.value)} autoComplete="off" />
                </div>
              ) : null}
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={busy} data-testid="coverage-estimate">{busy ? "Working out the estimate…" : "Get an estimate"}</Button>
            </div>
          </form>
        ) : plan && est ? (
          <div className="space-y-4" data-testid="coverage-plan">
            <h3 className="text-sm font-semibold">Estimate</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Addresses</dt><dd>{plan.urls}</dd>
              <dt className="text-muted-foreground">Pages</dt><dd>{range(est.pages.low, est.pages.high, String)}</dd>
              <dt className="text-muted-foreground">Size</dt><dd>{range(est.bytes.low, est.bytes.high, (n) => formatBytes(n))}</dd>
              <dt className="text-muted-foreground">Time</dt><dd>{range(est.durationSeconds.low, est.durationSeconds.high, formatDuration)}</dd>
              <dt className="text-muted-foreground">Confidence</dt><dd>{est.confidence}</dd>
            </dl>
            <p className="text-xs text-muted-foreground" data-testid="coverage-basis">This is an estimate, not a promise. Based on: {est.basis}.</p>
            {plan.warnings.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setStep("choose")}>Back</Button>
              <Button type="button" onClick={() => void queue()} disabled={busy} data-testid="coverage-queue">{busy ? "Queuing…" : "Queue for saving"}</Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
