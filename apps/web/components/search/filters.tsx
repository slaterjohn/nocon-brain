"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { AVAILABILITY_FILTERS, filterCount, typeLabel, type Availability, type Facet, type Facets, type SearchState } from "@/lib/search";

const SHOW = 6;

/** A group of checkboxes with counts. Values chosen earlier stay listed even when the counts no longer include them. */
function FacetGroup({
  name, legend, facets, selected, onChange, label = (f) => f.label,
}: {
  name: string;
  legend: string;
  facets: Facet[];
  selected: string[];
  onChange: (next: string[]) => void;
  label?: (f: Facet) => string;
}) {
  const [all, setAll] = React.useState(false);
  const list: Facet[] = [...facets];
  for (const v of selected) if (!list.some((f) => f.value === v)) list.push({ value: v, label: v, count: 0 });
  if (!list.length) return null;
  const shown = all ? list : list.filter((f, i) => i < SHOW || selected.includes(f.value));
  return (
    <fieldset className="min-w-0" data-testid={`filter-${name}`}>
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <ul className="space-y-1">
        {shown.map((f) => {
          const id = `flt-${name}-${f.value}`.replace(/[^a-z0-9_-]/gi, "_");
          const on = selected.includes(f.value);
          return (
            <li key={f.value} className="flex items-center gap-2">
              <Checkbox id={id} checked={on} onCheckedChange={(v) => onChange(v === true ? [...selected, f.value] : selected.filter((x) => x !== f.value))} />
              <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm font-normal">
                <span className="break-words">{label(f)}</span> <span className="text-muted-foreground" data-testid="facet-count">({f.count})</span>
              </Label>
            </li>
          );
        })}
      </ul>
      {list.length > shown.length || (all && list.length > SHOW) ? (
        <Button type="button" variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${list.length}`}<span className="sr-only"> {legend.toLowerCase()}</span>
        </Button>
      ) : null}
    </fieldset>
  );
}

/** Which knowledge packages to search. Nothing ticked means every package that is switched on. */
function PackageFilter({ packages, selected, onChange }: { packages: { id: string; title: string }[]; selected: string[]; onChange: (next: string[]) => void }) {
  if (!packages.length) return null;
  return (
    <fieldset className="min-w-0" data-testid="filter-packages">
      <legend className="mb-1.5 text-sm font-medium">Packages</legend>
      <ul className="space-y-1">
        {packages.map((p) => {
          const id = `flt-pkg-${p.id}`;
          return (
            <li key={p.id} className="flex items-center gap-2">
              <Checkbox id={id} checked={selected.includes(p.id)} onCheckedChange={(v) => onChange(v === true ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
              <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm font-normal"><span className="break-words">{p.title}</span></Label>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">Leave all unticked to search every package.</p>
    </fieldset>
  );
}

export function FiltersPanel({
  state, facets, onChange, onClear, packages = [],
}: {
  state: SearchState;
  facets: Facets;
  packages?: { id: string; title: string }[];
  onChange: (patch: Partial<SearchState>) => void;
  onClear: () => void;
}) {
  const [advanced, setAdvanced] = React.useState(false);
  const total = filterCount(state);
  const advancedCount =
    state.availability.length + state.languages.length + [state.dlFrom, state.dlTo, state.pubFrom, state.pubTo].filter(Boolean).length;
  return (
    <div className="space-y-5" data-testid="filters">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Filters</h2>
        {total > 0 ? (
          <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={onClear} data-testid="clear-filters">
            Clear all filters
          </Button>
        ) : null}
      </div>
      {facets.approximate ? <p className="text-xs text-muted-foreground">Counts are approximate for a search with very many matches.</p> : null}
      {state.scope === "all" || state.scope === "offline" || state.scope === "zim" ? <PackageFilter packages={packages} selected={state.zimIds} onChange={(zimIds) => onChange({ zimIds })} /> : null}
      <FacetGroup name="source" legend="Source" facets={facets.sources} selected={state.sources} onChange={(sources) => onChange({ sources })} />
      <FacetGroup name="collection" legend="Collection" facets={facets.collections} selected={state.collections} onChange={(collections) => onChange({ collections })} />
      <FacetGroup name="domain" legend="Site" facets={facets.domains} selected={state.domains} onChange={(domains) => onChange({ domains })} />
      <FacetGroup name="type" legend="Type" facets={facets.types} selected={state.types} onChange={(types) => onChange({ types })} label={(f) => typeLabel(f.value)} />
      <AdvancedSettings title="Advanced filters" open={advanced} onOpenChange={setAdvanced} changed={advancedCount} id="search-advanced">
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Date saved</legend>
          <div className="grid gap-2">
            <div><Label htmlFor="flt-dl-from" className="mb-1 block text-xs font-normal text-muted-foreground">From</Label><Input id="flt-dl-from" type="date" value={state.dlFrom} onChange={(e) => onChange({ dlFrom: e.target.value })} /></div>
            <div><Label htmlFor="flt-dl-to" className="mb-1 block text-xs font-normal text-muted-foreground">To</Label><Input id="flt-dl-to" type="date" value={state.dlTo} onChange={(e) => onChange({ dlTo: e.target.value })} /></div>
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Date published</legend>
          <div className="grid gap-2">
            <div><Label htmlFor="flt-pub-from" className="mb-1 block text-xs font-normal text-muted-foreground">From</Label><Input id="flt-pub-from" type="date" value={state.pubFrom} onChange={(e) => onChange({ pubFrom: e.target.value })} /></div>
            <div><Label htmlFor="flt-pub-to" className="mb-1 block text-xs font-normal text-muted-foreground">To</Label><Input id="flt-pub-to" type="date" value={state.pubTo} onChange={(e) => onChange({ pubTo: e.target.value })} /></div>
          </div>
        </fieldset>
        <fieldset data-testid="filter-availability">
          <legend className="mb-1.5 text-sm font-medium">Availability</legend>
          <ul className="space-y-1">
            {AVAILABILITY_FILTERS.map((a) => {
              const on = state.availability.includes(a.value);
              return (
                <li key={a.value} className="flex items-center gap-2">
                  <Checkbox
                    id={`flt-av-${a.value}`}
                    checked={on}
                    onCheckedChange={(v) => onChange({ availability: (v === true ? [...state.availability, a.value] : state.availability.filter((x) => x !== a.value)) as Availability[] })}
                  />
                  <Label htmlFor={`flt-av-${a.value}`} className="cursor-pointer text-sm font-normal">
                    {a.label}
                    {facets.availability.some((f) => f.value === a.value) ? <span className="text-muted-foreground" data-testid="facet-count"> ({facets.availability.find((f) => f.value === a.value)!.count})</span> : null}
                  </Label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        <FacetGroup name="language" legend="Language" facets={facets.languages} selected={state.languages} onChange={(languages) => onChange({ languages })} />
      </AdvancedSettings>
    </div>
  );
}
