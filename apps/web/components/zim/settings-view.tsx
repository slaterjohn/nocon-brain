"use client";

import * as React from "react";
import Link from "next/link";
import { errorMessage, fieldErrors, patch, useApi } from "@/lib/api";
import { useSearchPrefs } from "@/lib/search-prefs";
import {
  isZimMode, validateZimSettings, ZIM_MODE_HELP, ZIM_MODE_LABELS, ZIM_MODES, ZIM_SETTING_DEFAULTS, ZIM_SETTING_RANGES,
  type FieldErrors, type ZimMode, type ZimSearchSettings,
} from "@/lib/zim";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { ErrorSummary, type SummaryItem } from "@/components/common/error-summary";
import { Field } from "@/components/common/form";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";

interface SearchGroup { search?: Partial<ZimSearchSettings> }

const fid = (k: string) => `zimset-${k}`;

/** Knowledge package settings: how package results join a search, and the two limits behind it. */
export function ZimSettingsView() {
  const { toast } = useToast();
  const [prefs, setPrefs, prefsReady] = useSearchPrefs();
  const settings = useApi<SearchGroup>("/api/settings");
  const base: ZimSearchSettings = { ...ZIM_SETTING_DEFAULTS, ...(settings.data?.search ?? {}) } as ZimSearchSettings;
  const [draft, setDraft] = React.useState({ zimMaxPackagesPerSearch: "", zimHitsPerPackage: "" });
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [advOpen, setAdvOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const [tick, setTick] = React.useState(0);
  const loaded = !!settings.data;

  React.useEffect(() => {
    if (loaded) setDraft({ zimMaxPackagesPerSearch: String(base.zimMaxPackagesPerSearch), zimHitsPerPackage: String(base.zimHitsPerPackage) });
    // Reset the fields only when the saved values change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, base.zimMaxPackagesPerSearch, base.zimHitsPerPackage]);
  React.useEffect(() => {
    if (tick) summaryRef.current?.focus();
  }, [tick]);

  const dirty = draft.zimMaxPackagesPerSearch !== String(base.zimMaxPackagesPerSearch) || draft.zimHitsPerPackage !== String(base.zimHitsPerPackage);
  const changed = (Object.keys(ZIM_SETTING_DEFAULTS) as (keyof ZimSearchSettings)[]).filter((k) => String(base[k]) !== String(ZIM_SETTING_DEFAULTS[k])).length;

  async function changeMode(v: string) {
    if (!isZimMode(v)) return;
    try {
      await setPrefs({ zimResults: v as ZimMode });
      toast({ title: "Setting saved", description: ZIM_MODE_LABELS[v], variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't change the setting", description: errorMessage(e), variant: "error" });
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const { values, errors: local } = validateZimSettings(draft);
    if (!values) {
      setErrors(local);
      setAdvOpen(true);
      setTick((t) => t + 1);
      return;
    }
    setSaving(true);
    try {
      const out = await patch<SearchGroup>("/api/settings", { search: values });
      settings.setData({ ...settings.data, search: { ...settings.data?.search, ...out.search } });
      setErrors({});
      toast({ title: "Settings saved", variant: "success" });
    } catch (err) {
      const fe = fieldErrors(err);
      const mapped: FieldErrors = {};
      for (const [k, v] of Object.entries(fe)) mapped[k.replace(/^search\./, "")] = v;
      setErrors(Object.keys(mapped).length ? mapped : { zimMaxPackagesPerSearch: errorMessage(err) });
      setAdvOpen(true);
      setTick((t) => t + 1);
    } finally {
      setSaving(false);
    }
  }

  const summary: SummaryItem[] = Object.entries(errors).map(([k, message]) => ({ id: fid(k), message }));

  return (
    <>
      <PageHeader title="Knowledge packages" description="Packages are ZIM files, such as an offline Wikipedia. Add and remove them in the Library. These settings decide how they take part in search." actions={<Button asChild variant="outline"><Link href="/library/packages">Open the packages</Link></Button>} />
      <div className="max-w-2xl space-y-8">
        <section aria-labelledby="zim-results-h" className="space-y-3">
          <h2 id="zim-results-h" className="text-lg font-semibold">Package results in search</h2>
          <Field id={fid("mode")} label="Show package results" hint={ZIM_MODE_HELP[prefs.zimResults]}>
            {(p) => (
              <Select {...p} className="max-w-sm" value={prefs.zimResults} disabled={!prefsReady} onChange={(e) => void changeMode(e.target.value)} data-testid="zim-mode">
                {ZIM_MODES.map((m) => <option key={m} value={m}>{ZIM_MODE_LABELS[m]}</option>)}
              </Select>
            )}
          </Field>
          <p className="text-xs text-muted-foreground">Saved to your account. The Packages tab on the results page always searches packages only.</p>
        </section>
        <section aria-labelledby="zim-limits-h" className="space-y-3">
          <h2 id="zim-limits-h" className="text-lg font-semibold">Limits</h2>
          {settings.isLoading ? <LoadingSkeleton rows={2} label="Loading settings" /> : null}
          {settings.error ? <ErrorState title="Couldn't load the settings" message={settings.error.message} onRetry={() => void settings.mutate()} /> : null}
          {loaded ? (
            <form onSubmit={(e) => void save(e)} noValidate className="space-y-4" data-testid="zim-limits-form">
              <ErrorSummary ref={summaryRef} items={summary} />
              <AdvancedSettings open={advOpen} onOpenChange={setAdvOpen} changed={changed} id="zimset-adv" title="Advanced settings: search limits">
                <Field id={fid("zimMaxPackagesPerSearch")} label="Packages asked in one search" hint={`Whole number from ${ZIM_SETTING_RANGES.zimMaxPackagesPerSearch[0]} to ${ZIM_SETTING_RANGES.zimMaxPackagesPerSearch[1]}. Higher priority packages go first. The usual value is ${ZIM_SETTING_DEFAULTS.zimMaxPackagesPerSearch}.`} error={errors.zimMaxPackagesPerSearch}>
                  {(p) => <Input {...p} inputMode="numeric" className="max-w-40" value={draft.zimMaxPackagesPerSearch} onChange={(e) => setDraft({ ...draft, zimMaxPackagesPerSearch: e.target.value })} autoComplete="off" data-testid="zim-max-packages" />}
                </Field>
                <Field id={fid("zimHitsPerPackage")} label="Results taken from each package" hint={`Whole number from ${ZIM_SETTING_RANGES.zimHitsPerPackage[0]} to ${ZIM_SETTING_RANGES.zimHitsPerPackage[1]}. The usual value is ${ZIM_SETTING_DEFAULTS.zimHitsPerPackage}.`} error={errors.zimHitsPerPackage}>
                  {(p) => <Input {...p} inputMode="numeric" className="max-w-40" value={draft.zimHitsPerPackage} onChange={(e) => setDraft({ ...draft, zimHitsPerPackage: e.target.value })} autoComplete="off" data-testid="zim-hits" />}
                </Field>
              </AdvancedSettings>
              <div className="flex gap-2">
                <Button type="submit" disabled={saving || !dirty} data-testid="zim-save">{saving ? "Saving…" : "Save limits"}</Button>
                <Button type="button" variant="outline" disabled={saving || !dirty} onClick={() => { setDraft({ zimMaxPackagesPerSearch: String(base.zimMaxPackagesPerSearch), zimHitsPerPackage: String(base.zimHitsPerPackage) }); setErrors({}); }}>Discard changes</Button>
              </div>
            </form>
          ) : null}
        </section>
        <section aria-labelledby="zim-wiki-h" className="space-y-2">
          <h2 id="zim-wiki-h" className="text-lg font-semibold">Wikipedia</h2>
          <p className="text-sm text-muted-foreground">Saving Wikipedia articles from the web needs a contact set on the server, and requests are paced and can be paused.</p>
          <Link href="/library/wikipedia" className="text-sm text-primary underline underline-offset-4 hover:no-underline">Wikipedia topic and status</Link>
        </section>
      </div>
    </>
  );
}
