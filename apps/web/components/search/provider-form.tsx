"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AdvancedSettings, useAdvancedDisclosure } from "@/components/common/advanced-settings";
import { ErrorSummary } from "@/components/common/error-summary";
import { Field, FormError, ToggleRow } from "@/components/common/form";
import { ApiError, errorMessage, fieldErrors, patch, post } from "@/lib/api";
import { ADAPTER_LABELS, type Provider } from "@/lib/online-search";

type Adapter = Provider["adapter"];

interface Draft {
  adapter: Adapter;
  name: string;
  enabled: boolean;
  priority: string;
  baseUrl: string;
  apiKey: string;
  removeKey: boolean;
  fallbackProviderId: string;
  timeoutMs: string;
  rateLimitPerSec: string;
  monthlyCap: string;
  dailyCap: string;
  language: string;
  region: string;
  safeSearch: Provider["safeSearch"];
  weight: string;
  cacheSeconds: string;
}

const NEEDS_KEY: Record<Adapter, boolean> = { searxng: false, brave: true, mojeek: true };
const MAX_CACHE: Record<Adapter, number | null> = { searxng: null, brave: 0, mojeek: 3600 };
const DEFAULT_NAME: Record<Adapter, string> = { searxng: "SearXNG", brave: "Brave Search", mojeek: "Mojeek" };
const ADVANCED = ["timeoutMs", "rateLimitPerSec", "monthlyCap", "dailyCap", "language", "region", "safeSearch", "weight", "storage.ttlSeconds", "storage.policy"] as const;

const STORAGE_NOTE: Record<Adapter, string> = {
  searxng: "Nothing is stored unless you set a cache time. SearXNG passes on results from other search engines, which have their own terms.",
  brave: "Results from Brave Search are never stored. They are shown while you look at them and then forgotten. Saving a result saves the page itself, not Brave's title or snippet.",
  mojeek: "Mojeek results may be kept for up to one hour so a repeated search does not use up your allowance. Never longer.",
};

function draftFrom(p: Provider | null, nextPriority: number): Draft {
  if (!p) {
    return {
      adapter: "searxng", name: DEFAULT_NAME.searxng, enabled: true, priority: String(nextPriority), baseUrl: "", apiKey: "", removeKey: false, fallbackProviderId: "",
      timeoutMs: "4000", rateLimitPerSec: "5", monthlyCap: "", dailyCap: "", language: "", region: "", safeSearch: "moderate", weight: "1", cacheSeconds: "0",
    };
  }
  return {
    adapter: p.adapter, name: p.name, enabled: p.enabled, priority: String(p.priority), baseUrl: p.baseUrl ?? "", apiKey: "", removeKey: false,
    fallbackProviderId: p.fallbackProviderId ?? "", timeoutMs: String(p.timeoutMs), rateLimitPerSec: String(p.rateLimitPerSec),
    monthlyCap: p.monthlyCap == null ? "" : String(p.monthlyCap), dailyCap: p.dailyCap == null ? "" : String(p.dailyCap),
    language: p.language ?? "", region: p.region ?? "", safeSearch: p.safeSearch, weight: String(p.weight), cacheSeconds: String(p.storage.ttlSeconds ?? 0),
  };
}

const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
const capOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

function bodyFrom(d: Draft, existing: Provider | null) {
  const body: Record<string, unknown> = {
    name: d.name.trim(),
    enabled: d.enabled,
    priority: num(d.priority),
    timeoutMs: num(d.timeoutMs),
    rateLimitPerSec: num(d.rateLimitPerSec),
    monthlyCap: capOrNull(d.monthlyCap),
    dailyCap: capOrNull(d.dailyCap),
    fallbackProviderId: d.fallbackProviderId || null,
    language: d.language.trim() || null,
    region: d.region.trim() || null,
    safeSearch: d.safeSearch,
    weight: num(d.weight),
    baseUrl: d.baseUrl.trim() || null,
  };
  if (!existing) body.adapter = d.adapter;
  if (d.apiKey) body.apiKey = d.apiKey;
  else if (d.removeKey) body.apiKey = null;
  const ttl = Math.max(0, Number(d.cacheSeconds) || 0);
  if (d.adapter === "mojeek") body.storage = ttl > 0 ? { policy: "ttl", ttlSeconds: ttl } : { policy: "none" };
  else if (d.adapter === "searxng") body.storage = { policy: "unrestricted", ttlSeconds: ttl };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/** Add or edit a provider. The key is write-only: it is never shown, and a saved one is only reported as saved. */
export function ProviderDialog({
  open, onOpenChange, provider, others, nextPriority, onNeedsDisclosure, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  provider: Provider | null;
  others: Provider[];
  nextPriority: number;
  /** The server refused to enable without the acknowledgement: ask the Human to read it, then call `retry`. */
  onNeedsDisclosure: (retry: () => Promise<void>) => void;
  onSaved: (p: Provider) => void;
}) {
  const [d, setD] = React.useState<Draft>(() => draftFrom(provider, nextPriority));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const adv = useAdvancedDisclosure(ADVANCED);

  React.useEffect(() => {
    if (!open) return;
    setD(draftFrom(provider, nextPriority));
    setErrors({});
    setFormError("");
    adv.setOpen(false);
    // Reset when the dialog opens for a provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider?.id]);

  const set = (p: Partial<Draft>) => setD((cur) => ({ ...cur, ...p }));
  const isNew = !provider;
  const needsKey = NEEDS_KEY[d.adapter];
  const hasKey = !!provider?.hasCredentials && !d.removeKey;
  const maxCache = MAX_CACHE[d.adapter];
  const changed = [d.timeoutMs !== "4000", d.monthlyCap !== "", d.dailyCap !== "", d.language !== "", d.region !== "", d.safeSearch !== "moderate", d.weight !== "1", d.cacheSeconds !== "0"].filter(Boolean).length;

  function pickAdapter(a: Adapter) {
    set({ adapter: a, name: !d.name || d.name === DEFAULT_NAME[d.adapter] ? DEFAULT_NAME[a] : d.name, rateLimitPerSec: a === "searxng" ? "5" : "1", cacheSeconds: a === "mojeek" ? "3600" : "0", apiKey: "" });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!d.name.trim()) local.name = "Enter a name.";
    if (d.adapter === "searxng" && !d.baseUrl.trim()) local.baseUrl = "Enter the address of the SearXNG server, for example http://searxng:8080.";
    if (d.enabled && needsKey && !d.apiKey && !hasKey) local.apiKey = "Enter the key before switching this provider on.";
    if (Object.keys(local).length) {
      setErrors(local);
      adv.reveal(local);
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    const attempt = async (ack: boolean) => {
      setBusy(true);
      setErrors({});
      setFormError("");
      try {
        const body = { ...bodyFrom(d, provider), ...(ack ? { acknowledged: true } : {}) };
        const saved = provider ? await patch<Provider>(`/api/search/providers/${provider.id}`, body) : await post<Provider>("/api/search/providers", body);
        onSaved(saved);
        onOpenChange(false);
      } catch (err) {
        const fe = fieldErrors(err);
        if (err instanceof ApiError && err.status === 400 && fe.acknowledged) {
          // Not acknowledged yet: show the disclosure, then try again with the acknowledgement.
          onNeedsDisclosure(() => attempt(true));
          return;
        }
        // The key and the credentials are never echoed back, so the messages carry no secrets.
        const mapped = fe;
        setErrors(mapped);
        if (mapped.baseUrl && d.adapter !== "searxng") adv.setOpen(true);
        setFormError(Object.keys(mapped).length ? "" : errorMessage(err));
        adv.reveal(mapped);
        requestAnimationFrame(() => summaryRef.current?.focus());
      } finally {
        setBusy(false);
      }
    };
    await attempt(false);
  }

  const summary = Object.entries(errors).map(([k, message]) => ({ id: `pf-${k.replace(/\W+/g, "-")}`, message }));
  const fid = (k: string) => `pf-${k.replace(/\W+/g, "-")}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" aria-describedby="provider-desc">
        <div>
          <DialogTitle>{isNew ? "Add a search provider" : `Edit ${provider!.name}`}</DialogTitle>
          <DialogDescription id="provider-desc" className="mt-1">
            A provider answers your web searches. The words you search for are sent to it.
          </DialogDescription>
        </div>
        <form ref={adv.formRef} onSubmit={(e) => void save(e)} className="space-y-5" noValidate>
          <ErrorSummary ref={summaryRef} items={summary} />
          <FormError message={formError} />
          {isNew ? (
            <Field id="pf-adapter" label="Provider">
              {(p) => (
                <Select {...p} value={d.adapter} onChange={(e) => pickAdapter(e.target.value as Adapter)}>
                  {(Object.keys(ADAPTER_LABELS) as Adapter[]).map((a) => <option key={a} value={a}>{ADAPTER_LABELS[a]}</option>)}
                </Select>
              )}
            </Field>
          ) : null}
          <Field id={fid("name")} label="Name" error={errors.name}>
            {(p) => <Input {...p} value={d.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />}
          </Field>
          {d.adapter === "searxng" ? (
            <Field id={fid("baseUrl")} label="Address of the SearXNG server" hint="For example http://searxng:8080. The server needs the json format switched on." error={errors.baseUrl}>
              {(p) => <Input {...p} type="url" inputMode="url" value={d.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} autoComplete="off" spellCheck={false} />}
            </Field>
          ) : null}
          {needsKey ? (
            <Field
              id={fid("apiKey")}
              label="Key"
              hint={hasKey ? "A key is saved. It is never shown again. Type a new one to replace it." : "Paste the key from your account with the provider. It is stored encrypted and never shown again."}
              error={errors.apiKey}
            >
              {(p) => (
                <div className="space-y-2">
                  {hasKey ? <p className="text-sm font-medium" data-testid="key-saved">Key saved</p> : null}
                  <Input {...p} type="password" value={d.apiKey} onChange={(e) => set({ apiKey: e.target.value })} autoComplete="new-password" spellCheck={false} placeholder={hasKey ? "Leave empty to keep the saved key" : ""} />
                  {provider?.hasCredentials ? (
                    <div className="flex items-center gap-2">
                      <Checkbox id="pf-remove-key" checked={d.removeKey} onCheckedChange={(v) => set({ removeKey: v === true, apiKey: v === true ? "" : d.apiKey })} />
                      <Label htmlFor="pf-remove-key" className="font-normal">Remove the saved key</Label>
                    </div>
                  ) : null}
                </div>
              )}
            </Field>
          ) : null}
          <p className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="storage-note">{provider?.storage.note ?? STORAGE_NOTE[d.adapter]}</p>
          <ToggleRow id="pf-enabled" label="Switched on" description="Used for web searches when online search is on.">
            {(p) => <Switch {...p} checked={d.enabled} onCheckedChange={(v) => set({ enabled: v })} />}
          </ToggleRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={fid("priority")} label="Priority" hint="1 is asked first." error={errors.priority}>
              {(p) => <Input {...p} type="number" min={1} max={1000} value={d.priority} onChange={(e) => set({ priority: e.target.value })} />}
            </Field>
            <Field id={fid("fallbackProviderId")} label="If it fails, ask" hint="Another provider that steps in on an error." optional error={errors.fallbackProviderId}>
              {(p) => (
                <Select {...p} value={d.fallbackProviderId} onChange={(e) => set({ fallbackProviderId: e.target.value })}>
                  <option value="">No fallback</option>
                  {others.filter((o) => o.id !== provider?.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <AdvancedSettings open={adv.open} onOpenChange={adv.setOpen} changed={changed} id="provider-advanced">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={fid("timeoutMs")} label="Time to wait (milliseconds)" hint="500 to 30000." error={errors.timeoutMs}>
                {(p) => <Input {...p} type="number" min={500} max={30000} value={d.timeoutMs} onChange={(e) => set({ timeoutMs: e.target.value })} />}
              </Field>
              <Field id={fid("rateLimitPerSec")} label="Requests per second" hint="NoConBrain never goes faster than this." error={errors.rateLimitPerSec}>
                {(p) => <Input {...p} type="number" min={0.1} max={50} step="any" value={d.rateLimitPerSec} onChange={(e) => set({ rateLimitPerSec: e.target.value })} />}
              </Field>
              <Field id={fid("monthlyCap")} label="Requests allowed per month" optional hint="Empty means no limit." error={errors.monthlyCap}>
                {(p) => <Input {...p} type="number" min={0} value={d.monthlyCap} onChange={(e) => set({ monthlyCap: e.target.value })} />}
              </Field>
              <Field id={fid("dailyCap")} label="Requests allowed per day" optional hint="Empty means no limit." error={errors.dailyCap}>
                {(p) => <Input {...p} type="number" min={0} value={d.dailyCap} onChange={(e) => set({ dailyCap: e.target.value })} />}
              </Field>
              <Field id={fid("language")} label="Language" optional hint="A code such as en-GB." error={errors.language}>
                {(p) => <Input {...p} value={d.language} onChange={(e) => set({ language: e.target.value })} autoComplete="off" />}
              </Field>
              <Field id={fid("region")} label="Region" optional hint="A two-letter country code such as GB." error={errors.region}>
                {(p) => <Input {...p} value={d.region} onChange={(e) => set({ region: e.target.value })} autoComplete="off" maxLength={2} />}
              </Field>
              <Field id={fid("safeSearch")} label="SafeSearch" error={errors.safeSearch}>
                {(p) => (
                  <Select {...p} value={d.safeSearch} onChange={(e) => set({ safeSearch: e.target.value as Draft["safeSearch"] })}>
                    <option value="off">Off</option>
                    <option value="moderate">Moderate</option>
                    <option value="strict">Strict</option>
                  </Select>
                )}
              </Field>
              <Field id={fid("weight")} label="Weight when results are merged" hint="1 is the normal weight." error={errors.weight}>
                {(p) => <Input {...p} type="number" min={0} max={10} step="any" value={d.weight} onChange={(e) => set({ weight: e.target.value })} />}
              </Field>
              {maxCache !== 0 ? (
                <Field id={fid("storage.ttlSeconds")} label="Cache time (seconds)" hint={maxCache ? `0 keeps nothing. At most ${maxCache}.` : "0 keeps nothing."} error={errors["storage.ttlSeconds"] ?? errors["storage.policy"]}>
                  {(p) => <Input {...p} type="number" min={0} max={maxCache ?? undefined} value={d.cacheSeconds} onChange={(e) => set({ cacheSeconds: e.target.value })} />}
                </Field>
              ) : null}
              {d.adapter !== "searxng" ? (
                <Field id={fid("baseUrl")} label="Address override" optional hint="Only for a proxy or a test server." error={errors.baseUrl} className="sm:col-span-2">
                  {(p) => <Input {...p} type="url" inputMode="url" value={d.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} autoComplete="off" spellCheck={false} />}
                </Field>
              ) : null}
            </div>
          </AdvancedSettings>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy} data-testid="provider-save">{busy ? "Saving…" : isNew ? "Add provider" : "Save changes"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
