"use client";

import * as React from "react";
import { Activity, FlaskConical, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { ApiError, del, errorMessage, fieldErrors, get, patch, post, useApi } from "@/lib/api";
import { ADAPTER_LABELS, errorSentence, type Provider, type ProvidersResponse, type SearchErrorCode } from "@/lib/online-search";
import { ProviderDialog } from "./provider-form";

const HEALTH: Record<Provider["health"]["state"], { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
  ok: { label: "Working", variant: "success" },
  degraded: { label: "Slow or failing", variant: "warning" },
  down: { label: "Not working", variant: "destructive" },
  unknown: { label: "Not tested yet", variant: "secondary" },
};

interface TestResult { ok: boolean; latencyMs: number; resultCount?: number; errorCode?: SearchErrorCode; message?: string; partial?: { failedEngines: string[] } }
interface UsageHistory { month: { period: string; requests: number; cap: number | null }; day: { period: string; requests: number; cap: number | null }; history: { period: string; requests: number }[] }

const noun = (n: number) => (n === 1 ? "request" : "requests");
const used = (u: { requests: number; cap: number | null }) => (u.cap == null ? `${u.requests} ${noun(u.requests)}, no limit set` : `${u.requests} of ${u.cap} ${noun(u.cap)}`);

/** The privacy text, read and confirmed before online search or a provider is first switched on. */
function DisclosureDialog({ open, text, onCancel, onConfirm }: { open: boolean; text: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [read, setRead] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setRead(false);
      setError("");
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent aria-describedby="disclosure-text">
        <div>
          <DialogTitle>Before you search the web</DialogTitle>
          <DialogDescription className="sr-only">Read how web search handles your search words, then confirm.</DialogDescription>
        </div>
        <p id="disclosure-text" className="text-sm" data-testid="disclosure-text">{text}</p>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Only the words you search for are sent, to the providers you switch on.</li>
          <li>Nothing is sent while online search is off, or while you work offline.</li>
          <li>Results from Brave Search are never stored.</li>
        </ul>
        <div className="flex items-start gap-2">
          <Checkbox id="disclosure-read" checked={read} onCheckedChange={(v) => setRead(v === true)} />
          <Label htmlFor="disclosure-read" className="font-normal">I have read this and want to search the web.</Label>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button
            disabled={!read || busy}
            data-testid="disclosure-confirm"
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Confirm
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProviderCard({
  p, byId, onToggle, onEdit, onDelete, onTested,
}: {
  p: Provider;
  byId: Map<string, Provider>;
  onToggle: (p: Provider, on: boolean) => Promise<void>;
  onEdit: (p: Provider) => void;
  onDelete: (p: Provider) => void;
  onTested: () => void;
}) {
  const { toast } = useToast();
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<TestResult | null>(null);
  const [history, setHistory] = React.useState<UsageHistory | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);
  const h = HEALTH[p.health.state];
  const fallback = p.fallbackProviderId ? byId.get(p.fallbackProviderId)?.name : null;

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await post<TestResult>(`/api/search/providers/${p.id}/test`));
      onTested();
    } catch (e) {
      setResult({ ok: false, latencyMs: 0, message: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  }
  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next && !history) {
      try {
        setHistory(await get<UsageHistory>(`/api/search/providers/${p.id}/usage`));
      } catch (e) {
        toast({ title: "Couldn't load the usage", description: errorMessage(e), variant: "error" });
        setShowHistory(false);
      }
    }
  }
  const nameId = `prov-${p.id}-name`;
  return (
    <li className="space-y-3 rounded-lg border p-4" data-testid="provider-card" data-provider={p.name}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 id={nameId} className="text-base font-semibold">{p.name}</h3>
        <Badge variant="outline">{ADAPTER_LABELS[p.adapter]}</Badge>
        <Badge variant={h.variant} data-testid="provider-health">{h.label}</Badge>
        {p.hasCredentials ? <Badge variant="secondary" data-testid="provider-key-saved">Key saved</Badge> : null}
        <div className="ml-auto flex items-center gap-2">
          <Switch id={`prov-${p.id}-on`} checked={p.enabled} onCheckedChange={(v) => void onToggle(p, v)} aria-labelledby={`${nameId} prov-${p.id}-on-l`} data-testid="provider-enabled" />
          <Label id={`prov-${p.id}-on-l`} htmlFor={`prov-${p.id}-on`} className="font-normal">{p.enabled ? "Switched on" : "Switched off"}</Label>
        </div>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {p.baseUrl ? (<><dt className="sr-only">Address</dt><dd className="truncate text-muted-foreground sm:col-span-2">{p.baseUrl}</dd></>) : null}
        <div><dt className="inline text-muted-foreground">Priority: </dt><dd className="inline">{p.priority}</dd></div>
        <div><dt className="inline text-muted-foreground">If it fails: </dt><dd className="inline">{fallback ?? "no fallback"}</dd></div>
        <div><dt className="inline text-muted-foreground">This month: </dt><dd className="inline" data-testid="usage-month">{used(p.usage.month)}</dd></div>
        <div><dt className="inline text-muted-foreground">Today: </dt><dd className="inline" data-testid="usage-day">{used(p.usage.day)}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">{p.storage.note}</p>
      {p.health.lastErrorCode && p.health.state !== "ok" ? <p className="text-sm">Last problem: {errorSentence(p.name, p.health.lastErrorCode)} (<code>{p.health.lastErrorCode}</code>).</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void test()} disabled={testing} data-testid="provider-test"><FlaskConical aria-hidden="true" /> {testing ? "Testing…" : "Test"}<span className="sr-only"> {p.name}</span></Button>
        <Button size="sm" variant="outline" onClick={() => onEdit(p)} data-testid="provider-edit"><Pencil aria-hidden="true" /> Edit<span className="sr-only"> {p.name}</span></Button>
        <Button size="sm" variant="outline" onClick={() => void toggleHistory()} aria-expanded={showHistory} data-testid="provider-usage"><Activity aria-hidden="true" /> Usage history<span className="sr-only"> for {p.name}</span></Button>
        <Button size="sm" variant="outline" onClick={() => onDelete(p)} data-testid="provider-delete"><Trash2 aria-hidden="true" /> Delete<span className="sr-only"> {p.name}</span></Button>
      </div>
      <div role="status" aria-live="polite" data-testid="provider-test-result">
        {result ? (
          result.ok ? (
            <p className="text-sm text-success">Working. {result.resultCount ?? 0} {result.resultCount === 1 ? "result" : "results"} in {result.latencyMs} ms.{result.partial?.failedEngines.length ? ` Some engines did not answer: ${result.partial.failedEngines.join(", ")}.` : ""}</p>
          ) : (
            <p className="text-sm text-destructive">
              {result.errorCode ? <>{errorSentence(p.name, result.errorCode)}. <code>{result.errorCode}</code>. </> : null}
              {result.message}
            </p>
          )
        ) : null}
      </div>
      {showHistory && history ? (
        <div className="text-sm" data-testid="usage-history">
          <p className="mb-1 text-muted-foreground">Requests per month, newest first.</p>
          {history.history.length ? (
            <table className="w-full max-w-sm text-left">
              <thead><tr><th scope="col" className="py-1 pr-4 font-medium">Month</th><th scope="col" className="py-1 font-medium">Requests</th></tr></thead>
              <tbody>{history.history.map((r) => <tr key={r.period}><td className="py-0.5 pr-4">{r.period}</td><td>{r.requests}</td></tr>)}</tbody>
            </table>
          ) : <p>No requests yet.</p>}
        </div>
      ) : null}
    </li>
  );
}

export function OnlineSearchSettings() {
  const { toast } = useToast();
  const q = useApi<ProvidersResponse>("/api/search/providers");
  const [editing, setEditing] = React.useState<Provider | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Provider | null>(null);
  const [disclosure, setDisclosure] = React.useState<{ then: () => Promise<void> } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const items = q.data?.items ?? [];
  const online = q.data?.online;
  const byId = React.useMemo(() => new Map(items.map((p) => [p.id, p])), [items]);
  const nextPriority = items.reduce((m, p) => Math.max(m, p.priority), 0) + 1;
  const acknowledged = !!online?.acknowledgedAt;

  async function setMaster(on: boolean) {
    if (on && !acknowledged) {
      setDisclosure({ then: async () => { await patch("/api/settings", { privacy: { onlineSearch: { enabled: true, acknowledged: true } } }); } });
      return;
    }
    try {
      await patch("/api/settings", { privacy: { onlineSearch: { enabled: on } } });
      await q.mutate();
    } catch (e) {
      toast({ title: "Couldn't change online search", description: errorMessage(e), variant: "error" });
    }
  }

  async function toggleProvider(p: Provider, on: boolean) {
    const attempt = async (ack: boolean) => {
      await patch(`/api/search/providers/${p.id}`, { enabled: on, ...(ack ? { acknowledged: true } : {}) });
      await q.mutate();
    };
    try {
      await attempt(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && fieldErrors(e).acknowledged) {
        setDisclosure({ then: () => attempt(true) });
        return;
      }
      toast({ title: `Couldn't switch ${p.name} ${on ? "on" : "off"}`, description: Object.values(fieldErrors(e))[0] ?? errorMessage(e), variant: "error" });
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await del(`/api/search/providers/${deleting.id}`);
      toast({ title: "Provider deleted", description: deleting.name, variant: "success" });
      setDeleting(null);
      await q.mutate();
    } catch (e) {
      toast({ title: "Couldn't delete the provider", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8" data-testid="online-settings">
      <PageHeader
        title="Online search"
        description="Search the web as well as your saved pages. Your saved pages are always searched first and never wait for the web."
      />
      {q.isLoading ? <LoadingSkeleton label="Loading search providers" rows={3} /> : null}
      {q.error ? <ErrorState title="Couldn't load the search providers" message={q.error.message} onRetry={() => void q.mutate()} /> : null}
      {online ? (
        <>
          <section aria-labelledby="os-master" className="space-y-3">
            <h2 id="os-master" className="text-lg font-semibold">Search the web</h2>
            <div className="flex items-start gap-3 rounded-lg border p-4">
              <Switch id="os-enabled" checked={online.enabled} onCheckedChange={(v) => void setMaster(v)} aria-describedby="os-enabled-d" data-testid="online-master" />
              <div>
                <Label htmlFor="os-enabled">Search the web as well as my saved pages</Label>
                <p id="os-enabled-d" className="mt-0.5 text-sm text-muted-foreground" data-testid="online-state-text">
                  {!online.enabled
                    ? "Off. Nothing is sent anywhere."
                    : online.state === "offline"
                      ? "On, but you are working offline, so nothing is sent."
                      : items.some((p) => p.enabled)
                        ? "On. Your search words go to the providers below that are switched on."
                        : "On, but no provider is switched on yet."}
                </p>
                {acknowledged ? <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" aria-hidden="true" /> You confirmed how web search works.</p> : null}
              </div>
            </div>
            <p className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="brave-statement">
              Results from Brave Search are never stored. They are shown while you look at them and then forgotten. If you save a result, NoConBrain saves the page itself, not Brave&apos;s title or snippet.
            </p>
          </section>

          <section aria-labelledby="os-providers" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="os-providers" className="text-lg font-semibold">Search providers</h2>
              <Button onClick={() => { setEditing(null); setFormOpen(true); }} data-testid="provider-add"><Plus aria-hidden="true" /> Add a provider</Button>
            </div>
            {items.length === 0 ? (
              <EmptyState title="No search providers" description="Add SearXNG, Brave Search or Mojeek to search the web. Until then, searches use your saved pages only." />
            ) : (
              <ul className="space-y-3" data-testid="provider-list">
                {items.map((p) => (
                  <ProviderCard key={p.id} p={p} byId={byId} onToggle={toggleProvider} onEdit={(x) => { setEditing(x); setFormOpen(true); }} onDelete={setDeleting} onTested={() => void q.mutate()} />
                ))}
              </ul>
            )}
          </section>

          <ProviderDialog
            open={formOpen}
            onOpenChange={setFormOpen}
            provider={editing}
            others={items}
            nextPriority={nextPriority}
            onNeedsDisclosure={(retry) => setDisclosure({ then: retry })}
            onSaved={(saved) => {
              toast({ title: editing ? "Provider saved" : "Provider added", description: saved.name, variant: "success" });
              void q.mutate();
            }}
          />
          <DisclosureDialog
            open={!!disclosure}
            text={online.disclosure}
            onCancel={() => setDisclosure(null)}
            onConfirm={async () => {
              await disclosure!.then();
              setDisclosure(null);
              await q.mutate();
            }}
          />
          <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
            <DialogContent aria-describedby="prov-del-desc">
              <div>
                <DialogTitle>Delete this provider?</DialogTitle>
                <DialogDescription id="prov-del-desc" className="mt-1">{deleting?.name}. Its saved key and usage counts are removed. Saved pages are not affected.</DialogDescription>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
                <Button variant="destructive" onClick={() => void remove()} disabled={busy} data-testid="provider-delete-confirm">Delete provider</Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}
