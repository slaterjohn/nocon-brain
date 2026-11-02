"use client";

import * as React from "react";
import Link from "next/link";
import { errorMessage, put, useApi } from "@/lib/api";
import {
  ADVANCED_GROUPS, CEILING_FIELDS, LIMIT_FIELDS, MODES, PASSIVE_FIELDS, POOL_FIELDS, SEARCH_FIELDS, WEIGHT_FIELDS, WINDOW_FIELD, DEFAULTS,
  allOffByDefault, defaultText, draftToSettings, getPath, groupOfField, limitRows, mapServerErrors, parseField, sameDraft, toDraft,
  type ActiveMode, type AdvancedGroup, type BoolField, type Draft, type FieldErrors, type NumField, type ProfileMaximums, type SettingsView,
} from "@/lib/discovery";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { ErrorSummary } from "@/components/common/error-summary";
import { Field, ToggleRow } from "@/components/common/form";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { ConfirmDialog, Notice } from "@/components/storage/shared";
import { useSources } from "@/components/library/hooks";

const fid = (path: string) => `dset-${path.replace(/\./g, "-")}`;

/** Profile maximum shown beside a ceiling or pool field. */
const PROFILE_KEY: Record<string, keyof ProfileMaximums> = {
  "ceilings.maxDepth": "maxDepth",
  "ceilings.maxQueued": "maxQueued",
  "ceilings.maxRequestsPerDay": "maxRequestsPerDay",
  "ceilings.maxBytesPerDay": "maxBytesPerDay",
  "pool.maxCandidates": "maxCandidates",
};

function profileMaxText(f: NumField, max: ProfileMaximums, profile: string): string | null {
  const key = PROFILE_KEY[f.path];
  if (!key) return null;
  const v = max[key];
  return `Highest allowed on the ${profile} profile: ${f.kind === "bytes" ? `${(v / 1048576).toLocaleString("en-GB")} MiB` : v.toLocaleString("en-GB")}.`;
}

function SettingsForm({ view, onSaved }: { view: SettingsView; onSaved: (v: SettingsView) => void }) {
  const { toast } = useToast();
  const { sources } = useSources();
  const base = view.settings;
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(base));
  const saved = React.useMemo(() => toDraft(base), [base]);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [general, setGeneral] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState<Record<AdvancedGroup, boolean>>({ limits: false, pool: false, ceilings: false, weights: false });
  const [saving, setSaving] = React.useState(false);
  const [ackOpen, setAckOpen] = React.useState(false);
  const [ackChecked, setAckChecked] = React.useState(false);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const [summaryTick, setSummaryTick] = React.useState(0);

  const dirty = !sameDraft(draft, saved);
  const needsAck = draft.mode === "automatic" && base.active.mode !== "automatic";

  React.useEffect(() => {
    if (summaryTick) summaryRef.current?.focus();
  }, [summaryTick]);

  const clearError = (path: string) => setErrors((e) => (path in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== path)) : e));
  const setBool = (path: string, v: boolean) => {
    setDraft((d) => ({ ...d, bools: { ...d.bools, [path]: v } }));
    clearError(path);
  };
  const setNum = (path: string, v: string) => {
    setDraft((d) => ({ ...d, nums: { ...d.nums, [path]: v } }));
    clearError(path);
  };

  function chooseMode(m: ActiveMode) {
    if (m === draft.mode) return;
    if (m === "automatic" && base.active.mode !== "automatic") {
      setAckChecked(false);
      setAckOpen(true);
      return;
    }
    setDraft((d) => ({ ...d, mode: m }));
    clearError("active.mode");
  }

  function showErrors(fields: FieldErrors, more: string[]) {
    setErrors(fields);
    setGeneral(more);
    const groups = new Set<AdvancedGroup>();
    for (const k of Object.keys(fields)) {
      const g = groupOfField(k);
      if (g) groups.add(g);
    }
    if (groups.size) setOpen((o) => ({ ...o, ...Object.fromEntries([...groups].map((g) => [g, true])) }));
    setSummaryTick((t) => t + 1);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const { settings, errors: local } = draftToSettings(draft, base);
    if (Object.keys(local).length) {
      showErrors(local, []);
      return;
    }
    setSaving(true);
    try {
      const body = { ...settings, ...(needsAck ? { acknowledged: true } : {}) };
      const next = await put<SettingsView>("/api/discovery/settings", body);
      setErrors({});
      setGeneral([]);
      onSaved(next);
      setDraft(toDraft(next.settings));
      toast({ title: "Settings saved", variant: "success" });
    } catch (err) {
      const m = mapServerErrors(err);
      if (Object.keys(m.fields).length || m.general.length) showErrors(m.fields, m.general);
      else showErrors({}, [errorMessage(err)]);
    } finally {
      setSaving(false);
    }
  }

  const summary = [
    ...Object.entries(errors).map(([path, message]) => ({ id: fid(path), message })),
    ...general.map((message) => ({ id: "dset-form", message })),
  ];

  const bool = (f: BoolField, extra?: React.ReactNode) => (
    <ToggleRow
      key={f.path}
      id={fid(f.path)}
      label={f.label}
      description={<>{f.help} <span className="whitespace-nowrap font-medium" data-testid={`default-${f.path}`}>{defaultText(f.path)}.</span>{extra}</>}
    >
      {(p) => <Switch {...p} checked={draft.bools[f.path] === true} onCheckedChange={(v) => setBool(f.path, v)} data-testid={`set-${f.path}`} />}
    </ToggleRow>
  );

  const num = (f: NumField) => {
    const cap = profileMaxText(f, view.profileMaximums, view.profile);
    return (
      <Field
        key={f.path}
        id={fid(f.path)}
        label={f.label}
        error={errors[f.path]}
        hint={<>{f.help} <span className="font-medium">{defaultText(f.path)}.</span>{cap ? ` ${cap}` : ""}</>}
      >
        {(p) => (
          <div className="flex items-center gap-2">
            <Input {...p} inputMode="decimal" className="w-32" value={draft.nums[f.path] ?? ""} onChange={(e) => setNum(f.path, e.target.value)} data-testid={`set-${f.path}`} />
            {f.unit && f.kind !== "weight" ? <span className="text-sm text-muted-foreground" aria-hidden="true">{f.unit}</span> : null}
          </div>
        )}
      </Field>
    );
  };

  const changedCount = (group: AdvancedGroup) => {
    const prefixes: readonly string[] = ADVANCED_GROUPS[group];
    const fields = [...LIMIT_FIELDS, ...POOL_FIELDS, ...CEILING_FIELDS, ...WEIGHT_FIELDS].filter((f) => prefixes.some((p) => f.path === p || f.path.startsWith(`${p}.`)));
    let n = fields.filter((f) => parseField(f, draft.nums[f.path] ?? "") !== getPath(DEFAULTS, f.path)).length;
    if (group === "limits" && draft.bools[WINDOW_FIELD.path] !== DEFAULTS.active.respectSchedule) n += 1;
    return n;
  };

  const rows = limitRows(base, view.effective, view.profileMaximums, view.profile);
  const anyCapped = rows.some((r) => r.capped);
  const allOff = allOffByDefault(base);
  const modeErr = errors["active.mode"];
  const sourcesErr = errors["active.allowedSourceIds"];

  return (
    <form onSubmit={save} noValidate aria-label="Discovery settings" id="dset-form" tabIndex={-1} className="space-y-6 outline-none" data-testid="settings-form">
      <ErrorSummary ref={summaryRef} items={summary} title="Settings were not saved" />

      <Notice title={allOff ? "Everything is off" : "Discovery is set up"} testId="defaults-state">
        {allOff
          ? "Out of the box, discovery collects nothing, scores nothing, downloads nothing and keeps nothing. Each switch below says what it does and what it is set to by default."
          : "Each setting says what it does and what its default is. The defaults are all off or small, so you can always go back."}
      </Notice>

      <Card>
        <CardHeader>
          <CardTitle>Discovery</CardTitle>
          <CardDescription>The master switch. While it is off, nothing below does anything.</CardDescription>
        </CardHeader>
        <CardContent>
          {bool({ path: "enabled", label: "Suggest pages worth saving", help: "Switches discovery on. Suggestions can then be collected and scored. Nothing is downloaded by this switch alone." })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where suggestions come from</CardTitle>
          <CardDescription>Passive collectors. They only look at what is already on this server and use no network.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{PASSIVE_FIELDS.map((f) => bool(f))}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Web search</CardTitle>
          <CardDescription>
            Options that use your online searches. No search words are ever kept. They need <Link href="/storage/online-search" className="underline underline-offset-2">online search</Link> to be on.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{SEARCH_FIELDS.map((f) => bool(f))}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Downloading</CardTitle>
          <CardDescription>Whether discovery may download pages by itself. Downloads are ordinary saves at the lowest priority (P4), so storage checks, robots.txt and politeness still apply. They happen only while online.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <fieldset id="dset-active-mode" tabIndex={-1} aria-describedby={modeErr ? "dset-active-mode-error" : undefined} className="space-y-3 outline-none" data-testid="mode-group">
            <legend className="text-sm font-medium">When discovery may download <span className="font-normal text-muted-foreground">({defaultText("active.mode")}.)</span></legend>
            {MODES.map((m) => (
              <div key={m.value} className="flex items-start gap-3">
                <input
                  type="radio"
                  id={`dset-mode-${m.value}`}
                  name="dset-mode"
                  value={m.value}
                  checked={draft.mode === m.value}
                  onChange={() => chooseMode(m.value)}
                  aria-describedby={`dset-mode-${m.value}-d`}
                  aria-invalid={modeErr ? true : undefined}
                  className="mt-1 size-4 accent-[var(--color-primary)]"
                  data-testid={`mode-${m.value}`}
                />
                <div className="space-y-0.5">
                  <Label htmlFor={`dset-mode-${m.value}`}>{m.label}</Label>
                  <p id={`dset-mode-${m.value}-d`} className="text-xs text-muted-foreground">{m.help}</p>
                </div>
              </div>
            ))}
            {modeErr ? <p id="dset-active-mode-error" className="text-xs font-medium text-destructive">{modeErr}</p> : null}
            {needsAck ? <p className="text-xs text-muted-foreground" data-testid="ack-pending">Automatic mode is confirmed. It starts when you save.</p> : null}
          </fieldset>

          <fieldset id="dset-active-allowedSourceIds" tabIndex={-1} aria-describedby="dset-sources-d" className="space-y-2 outline-none" data-testid="allowed-sources">
            <legend className="text-sm font-medium">Sources automatic mode may follow</legend>
            <p id="dset-sources-d" className="text-xs text-muted-foreground">
              In automatic mode, links on pages from these sources may be downloaded. None ticked means none. Ask-first mode ignores this list, because approving is the decision. Default: none.
            </p>
            {sources.length === 0 ? <p className="text-sm text-muted-foreground">There are no sources yet.</p> : (
              <ul className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                {sources.map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`dset-src-${s.id}`}
                      checked={draft.allowedSourceIds.includes(s.id)}
                      onCheckedChange={(v) => {
                        setDraft((d) => ({ ...d, allowedSourceIds: v === true ? [...d.allowedSourceIds, s.id] : d.allowedSourceIds.filter((x) => x !== s.id) }));
                        clearError("active.allowedSourceIds");
                      }}
                    />
                    <Label htmlFor={`dset-src-${s.id}`} className="font-normal">{s.name}</Label>
                  </li>
                ))}
              </ul>
            )}
            {sourcesErr ? <p className="text-xs font-medium text-destructive">{sourcesErr}</p> : null}
          </fieldset>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Advanced</h2>
        <p className="text-sm text-muted-foreground">The defaults are safe. Open a section only to tighten or loosen a limit.</p>

        <AdvancedSettings title="Limits" id="dset-adv-limits" open={open.limits} onOpenChange={(o) => setOpen((x) => ({ ...x, limits: o }))} changed={changedCount("limits")}>
          <p className="text-sm text-muted-foreground">How much discovery may download. Each limit works on its own: a pass stops at whichever is reached first. None can be above its global ceiling.</p>
          {LIMIT_FIELDS.map(num)}
          {bool(WINDOW_FIELD)}
          <p className="text-sm" data-testid="online-only"><span className="font-medium">Only while online.</span> This cannot be changed: nothing is downloaded while the server is working offline or cannot reach the internet.</p>
        </AdvancedSettings>

        <AdvancedSettings title="Suggestion pool" id="dset-adv-pool" open={open.pool} onOpenChange={(o) => setOpen((x) => ({ ...x, pool: o }))} changed={changedCount("pool")}>
          <p className="text-sm text-muted-foreground">How many suggestions are kept and for how long.</p>
          {POOL_FIELDS.map(num)}
        </AdvancedSettings>

        <AdvancedSettings title="Global ceilings" id="dset-adv-ceilings" open={open.ceilings} onOpenChange={(o) => setOpen((x) => ({ ...x, ceilings: o }))} changed={changedCount("ceilings")}>
          <p className="text-sm text-muted-foreground">
            The most discovery may ever do, whatever the limits above say. A ceiling cannot be set higher than the maximum for your resource profile ({view.profile}), which is the most a crawl is ever allowed to do.
            Raise a ceiling before raising a limit that depends on it.
          </p>
          {CEILING_FIELDS.map(num)}
        </AdvancedSettings>

        <AdvancedSettings title="Scoring weights" id="dset-adv-weights" open={open.weights} onOpenChange={(o) => setOpen((x) => ({ ...x, weights: o }))} changed={changedCount("weights")}>
          <p className="text-sm text-muted-foreground">
            The score is a weighted sum: each factor is measured from 0 to 1, multiplied by its weight, and the results are added. Weights run from -100 to 100. A negative weight takes points away. A suggestion needs at least the lowest score (set under Limits) for automatic downloads.
          </p>
          {WEIGHT_FIELDS.map(num)}
        </AdvancedSettings>
      </div>

      <section aria-labelledby="inforce-h" className="space-y-3" data-testid="in-force">
        <h2 id="inforce-h" className="text-lg font-semibold">What is really in force</h2>
        <p className="text-sm text-muted-foreground">
          The limit that applies is the smallest of what you set, the global ceiling and the maximum for your resource profile (<strong>{view.profile}</strong>). If you change the profile, these figures change at once, whatever is set above.
        </p>
        <Table aria-label="Limits in force">
          <caption className="sr-only">For each limit: the value saved in the settings, the value in force now, and the reason when they differ.</caption>
          <TableHeader>
            <TableRow><TableHead>Limit</TableHead><TableHead className="text-right">Set to</TableHead><TableHead className="text-right">In force</TableHead><TableHead>Note</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key} data-testid="limit-row" data-key={r.key} data-capped={r.capped ? "true" : "false"}>
                <TableCell>{r.label}</TableCell>
                <TableCell className="text-right tabular-nums">{r.setting}</TableCell>
                <TableCell className="text-right font-medium tabular-nums" data-testid="limit-effective">{r.effective}</TableCell>
                <TableCell>{r.capped ? <span data-testid="limit-reason">{r.reason}</span> : <span className="text-muted-foreground">As set</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {anyCapped ? <Notice tone="warning" testId="capped-note">A profile maximum or ceiling is holding at least one limit below what you set. Raise the ceiling, or move to a larger profile, to use the higher figure.</Notice> : null}
        <Table aria-label="Profile maximums">
          <caption className="sr-only">The most each limit can be on the {view.profile} profile.</caption>
          <TableHeader><TableRow><TableHead>Profile maximum ({view.profile})</TableHead><TableHead className="text-right">Value</TableHead></TableRow></TableHeader>
          <TableBody>
            <TableRow><TableCell>Hops from a saved page</TableCell><TableCell className="text-right tabular-nums" data-testid="pmax-depth">{view.profileMaximums.maxDepth.toLocaleString("en-GB")}</TableCell></TableRow>
            <TableRow><TableCell>Downloads waiting at once</TableCell><TableCell className="text-right tabular-nums">{view.profileMaximums.maxQueued.toLocaleString("en-GB")}</TableCell></TableRow>
            <TableRow><TableCell>Suggestions kept at once</TableCell><TableCell className="text-right tabular-nums">{view.profileMaximums.maxCandidates.toLocaleString("en-GB")}</TableCell></TableRow>
            <TableRow><TableCell>Requests a day</TableCell><TableCell className="text-right tabular-nums">{view.profileMaximums.maxRequestsPerDay.toLocaleString("en-GB")}</TableCell></TableRow>
            <TableRow><TableCell>Data a day</TableCell><TableCell className="text-right tabular-nums" data-testid="pmax-bytes">{(view.profileMaximums.maxBytesPerDay / 1048576).toLocaleString("en-GB")} MiB</TableCell></TableRow>
          </TableBody>
        </Table>
      </section>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 border-t bg-background px-1 py-3">
        <Button type="submit" disabled={!dirty || saving} data-testid="settings-save">{saving ? "Saving…" : "Save changes"}</Button>
        <Button type="button" variant="outline" disabled={!dirty || saving} onClick={() => { setDraft(saved); setErrors({}); setGeneral([]); }} data-testid="settings-discard">Discard changes</Button>
        <p role="status" className="text-sm text-muted-foreground" data-testid="settings-state">{dirty ? "You have changes that are not saved." : "No unsaved changes."}</p>
      </div>

      <ConfirmDialog
        open={ackOpen}
        onOpenChange={setAckOpen}
        title="Turn on automatic downloads?"
        confirmLabel="Use automatic mode"
        confirmDisabled={!ackChecked}
        onConfirm={() => {
          setDraft((d) => ({ ...d, mode: "automatic" }));
          clearError("active.mode");
          setAckOpen(false);
        }}
        testId="ack"
        description={
          <>
            <p>Discovery will download pages <strong>without asking each time</strong>. It will pick pages that are new, that link from the sources you tick, and that score at least the lowest score.</p>
            <p>It still keeps to your limits: {base.active.maxRequestsPerDay.toLocaleString("en-GB")} requests and {(base.active.maxBytesPerDay / 1048576).toLocaleString("en-GB")} MiB a day, at most {base.active.perSiteDailyCap.toLocaleString("en-GB")} per site, only while online. Downloaded pages use storage at the lowest priority and can be removed first when space runs short.</p>
            <p>You can stop it at any time with the kill switch on the Budget and runner page.</p>
          </>
        }
      >
        <div className="flex items-start gap-2">
          <Checkbox id="ack-understand" checked={ackChecked} onCheckedChange={(v) => setAckChecked(v === true)} data-testid="ack-checkbox" />
          <Label htmlFor="ack-understand" className="font-normal">I understand that discovery will download pages without asking me each time.</Label>
        </div>
      </ConfirmDialog>
    </form>
  );
}

export function DiscoverySettingsView() {
  const q = useApi<SettingsView>("/api/discovery/settings");
  return (
    <>
      <PageHeader
        title="Discovery settings"
        description="Everything here is off or small by default. Each setting says what it does, what it is set to by default and what limits apply."
        actions={<Link href="/storage" className="text-sm text-primary underline underline-offset-2">All settings</Link>}
      />
      {q.error && !q.data ? (
        <ErrorState title="Couldn't load the settings" message={q.error.message} onRetry={() => void q.mutate()} />
      ) : !q.data ? (
        <LoadingSkeleton variant="page" label="Loading the settings" />
      ) : (
        <SettingsForm view={q.data} onSaved={(v) => q.setData(v)} />
      )}
    </>
  );
}
