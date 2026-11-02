"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Field, ToggleRow } from "@/components/common/form";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { PRIORITIES, PROFILES, MODES, SOURCE_TYPES, EVICTION_EXPLANATION, RETENTION_MODES } from "@/lib/library-copy";
import {
  ALL_DAYS, CRAWL_TYPES, DAY_LABEL, isWebType, validateUrl, type Draft,
} from "@/lib/source-draft";
import type { Collection, Priority, SourceCeilings, SourceType } from "@/lib/types";
import { formatBytes } from "@/lib/utils";

export const fid = (key: string) => `sf-${key.replace(/[^a-zA-Z0-9]+/g, "-")}`;

export interface SectionProps {
  d: Draft;
  set: (patch: Partial<Draft>) => void;
  errors: Record<string, string>;
  ceil: SourceCeilings | null;
}

function Radio({
  name, value, checked, onChange, label, description, disabled, badge, testId, describedBy,
}: {
  name: string; value: string; checked: boolean; onChange: () => void; label: string; description?: string; disabled?: boolean; badge?: string; testId?: string; describedBy?: string;
}) {
  const id = `${name}-${value}`;
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border p-3", checked && "border-primary bg-accent/40", disabled && "bg-muted/40")}>
      <input
        type="radio"
        id={id}
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-describedby={describedBy ?? (description ? `${id}-desc` : undefined)}
        className="mt-1 size-4 accent-[var(--primary)]"
        data-testid={testId}
      />
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="flex flex-wrap items-center gap-2">
          {label}
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
        </Label>
        {description ? <p id={`${id}-desc`} className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
    </div>
  );
}

/** Step 1: what kind of source. Types that are not built yet are listed, disabled, with the reason beside them. */
export function TypeSection({ d, set, errors }: SectionProps) {
  const err = errors.type;
  return (
    <fieldset className="space-y-3" aria-describedby={err ? "sf-type-error" : undefined}>
      <legend className="mb-1 text-sm font-semibold">What do you want to save?</legend>
      <div className="grid gap-2 sm:grid-cols-2" id={fid("type")} tabIndex={-1}>
        {SOURCE_TYPES.map((t) => (
          <Radio
            key={t.value}
            name="source-type"
            value={t.value}
            checked={d.type === t.value}
            onChange={() => set({ type: t.value, mode: CRAWL_TYPES.includes(t.value) ? (d.mode === "capture" ? "explore" : d.mode) : "capture", includeExternal: t.value === "linked_collection" })}
            label={t.label}
            description={t.later ? `Coming later. ${t.later}` : t.description}
            disabled={!!t.later}
            badge={t.later ? "Coming later" : undefined}
            testId={`type-${t.value}`}
          />
        ))}
      </div>
      {err ? <p id="sf-type-error" className="text-xs font-medium text-destructive">{err}</p> : null}
    </fieldset>
  );
}

export function NumberInput(props: React.ComponentProps<typeof Input>) {
  return <Input inputMode="numeric" autoComplete="off" {...props} />;
}

/** Step 2: the address, mode, profile and limits. Rarely changed scope options go in the disclosure. */
export function AddressSection({ d, set, errors, ceil, advancedOpen, onAdvancedOpen }: SectionProps & { advancedOpen: boolean; onAdvancedOpen: (o: boolean) => void }) {
  const info = SOURCE_TYPES.find((t) => t.value === d.type);
  const web = isWebType(d.type);
  const crawl = CRAWL_TYPES.includes(d.type as SourceType);
  const [touched, setTouched] = React.useState(false);
  const live = web ? validateUrl(d.startUrl) : null;
  const urlError = errors.startUrl ?? (touched && live && !live.ok && d.startUrl.trim() ? live.message : undefined);
  const advancedChanged = [
    d.allowedDomains, d.excludedDomains, d.allowedPaths, d.excludedPaths, d.externalDepth, d.queryParamPolicy, d.assets,
  ].filter(Boolean).length + (d.respectRobots ? 0 : 1) + (d.includeExternal !== (d.type === "linked_collection") ? 1 : 0);

  return (
    <div className="space-y-5">
      <Field id={fid("name")} label="Name" hint="Shown in the Library and on the Downloads screen." error={errors.name}>
        {(p) => <Input {...p} value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} autoComplete="off" />}
      </Field>

      {web ? (
        <div>
          <Field id={fid("startUrl")} label={info?.addressLabel || "Start address"} hint={info?.addressHint} error={urlError}>
            {(p) => (
              <Input
                {...p}
                type="url"
                inputMode="url"
                value={d.startUrl}
                onChange={(e) => set({ startUrl: e.target.value })}
                onBlur={() => setTouched(true)}
                placeholder="https://example.org/"
                autoComplete="off"
                spellCheck={false}
                data-testid="start-url"
              />
            )}
          </Field>
          <div role="status" aria-live="polite" className="mt-1 min-h-5 text-xs" data-testid="url-status">
            {d.startUrl.trim() && live?.ok ? <span className="text-success">This looks like a valid web address.</span> : null}
            {d.startUrl.trim() && live && !live.ok && live.suggestion ? (
              <button type="button" className="underline underline-offset-2" onClick={() => set({ startUrl: live.suggestion! })}>
                Use {live.suggestion}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <Field id={fid("description")} label="Description" optional>
        {(p) => <Textarea {...p} value={d.description} onChange={(e) => set({ description: e.target.value })} maxLength={1000} rows={2} />}
      </Field>

      {crawl ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">Mode</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODES.filter((m) => m.value !== "capture").map((m) => (
              <Radio key={m.value} name="source-mode" value={m.value} checked={d.mode === m.value} onChange={() => set({ mode: m.value })} label={m.label} description={m.explanation} testId={`mode-${m.value}`} />
            ))}
          </div>
        </fieldset>
      ) : null}

      {web && d.type !== "single_page" ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">How much to save</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROFILES.map((p) => (
              <Radio key={p.value} name="source-profile" value={p.value} checked={d.profile === p.value} onChange={() => set({ profile: p.value })} label={p.label} description={p.explanation} testId={`profile-${p.value}`} />
            ))}
          </div>
          {d.profile === "custom" ? (
            <div className="grid gap-4 pt-2 sm:grid-cols-3">
              <Field id={fid("config.depth")} label="Depth (links from the start)" hint={ceil ? `Up to ${ceil.depth} on this device.` : undefined} error={errors["config.depth"]}>
                {(p) => <NumberInput {...p} value={d.depth} onChange={(e) => set({ depth: e.target.value })} />}
              </Field>
              <Field id={fid("config.maxPages")} label="Maximum pages" hint={ceil ? `Up to ${ceil.maxPages.toLocaleString("en-GB")} on this device.` : undefined} error={errors["config.maxPages"]}>
                {(p) => <NumberInput {...p} value={d.maxPages} onChange={(e) => set({ maxPages: e.target.value })} />}
              </Field>
              <Field id={fid("config.maxBytes")} label="Maximum size (MB)" hint={ceil ? `Up to ${formatBytes(ceil.maxBytes, 0)} on this device.` : undefined} error={errors["config.maxBytes"]}>
                {(p) => <NumberInput {...p} value={d.maxMb} onChange={(e) => set({ maxMb: e.target.value })} />}
              </Field>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">NoConBrain also has hard limits for this device that no source can exceed{ceil ? `: up to ${ceil.maxPages.toLocaleString("en-GB")} pages, ${ceil.depth} links deep and ${formatBytes(ceil.maxBytes, 0)}` : ""}.</p>
          )}
        </fieldset>
      ) : null}

      {web && d.type !== "single_page" ? (
        <AdvancedSettings title="Advanced settings: scope" open={advancedOpen} onOpenChange={onAdvancedOpen} changed={advancedChanged} id="adv-scope">
          {d.type !== "sitemap" && d.type !== "feed" ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={fid("config.allowedDomains")} label="Only these sites" hint="One per line. Leave empty to stay on the start site." optional error={errors["config.allowedDomains"]}>
                  {(p) => <Textarea {...p} value={d.allowedDomains} onChange={(e) => set({ allowedDomains: e.target.value })} rows={3} spellCheck={false} />}
                </Field>
                <Field id={fid("config.excludedDomains")} label="Never these sites" hint="One per line." optional error={errors["config.excludedDomains"]}>
                  {(p) => <Textarea {...p} value={d.excludedDomains} onChange={(e) => set({ excludedDomains: e.target.value })} rows={3} spellCheck={false} />}
                </Field>
                <Field id={fid("config.allowedPaths")} label="Only these paths" hint="One per line, such as /docs/**. A section already stays in its folder." optional error={errors["config.allowedPaths"]}>
                  {(p) => <Textarea {...p} value={d.allowedPaths} onChange={(e) => set({ allowedPaths: e.target.value })} rows={3} spellCheck={false} />}
                </Field>
                <Field id={fid("config.excludedPaths")} label="Never these paths" hint="One per line, such as /login/**." optional error={errors["config.excludedPaths"]}>
                  {(p) => <Textarea {...p} value={d.excludedPaths} onChange={(e) => set({ excludedPaths: e.target.value })} rows={3} spellCheck={false} />}
                </Field>
              </div>
              <ToggleRow id={fid("config.includeExternal")} label="Follow links to other sites" description="Saves pages that the start page links to on other sites, for as many hops as the other-site depth allows.">
                {(p) => <Switch {...p} checked={d.includeExternal} onCheckedChange={(v) => set({ includeExternal: v })} />}
              </ToggleRow>
              {d.includeExternal ? (
                <Field id={fid("config.externalDepth")} label="Hops to other sites" hint={ceil ? `Up to ${ceil.externalDepth} on this device. Leave empty for the default.` : "Leave empty for the default."} optional error={errors["config.externalDepth"]}>
                  {(p) => <NumberInput {...p} className="max-w-32" value={d.externalDepth} onChange={(e) => set({ externalDepth: e.target.value })} />}
                </Field>
              ) : null}
            </>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={fid("config.queryParamPolicy")} label="Web address parameters" hint="Parts after a ? in an address. Tracking ones are usually noise." error={errors["config.queryParamPolicy"]}>
              {(p) => (
                <Select {...p} value={d.queryParamPolicy} onChange={(e) => set({ queryParamPolicy: e.target.value as Draft["queryParamPolicy"] })}>
                  <option value="">Default: remove tracking parameters</option>
                  <option value="keep_all">Keep all</option>
                  <option value="strip_tracking">Remove tracking parameters</option>
                  <option value="allowlist">Keep only the ones I list</option>
                  <option value="drop_all">Remove all</option>
                </Select>
              )}
            </Field>
            <Field id={fid("config.assets")} label="Images, styles and fonts" error={errors["config.assets"]}>
              {(p) => (
                <Select {...p} value={d.assets} onChange={(e) => set({ assets: e.target.value as Draft["assets"] })}>
                  <option value="">Default: from the same site</option>
                  <option value="all">All, including other sites</option>
                  <option value="same_origin">From the same site</option>
                  <option value="images_css_only">Images and styles only</option>
                  <option value="none">None (text only)</option>
                </Select>
              )}
            </Field>
          </div>
          {d.queryParamPolicy === "allowlist" ? (
            <Field id={fid("config.queryParamAllowlist")} label="Parameters to keep" hint="One per line." error={errors["config.queryParamAllowlist"]}>
              {(p) => <Textarea {...p} value={d.queryParamAllowlist} onChange={(e) => set({ queryParamAllowlist: e.target.value })} rows={2} spellCheck={false} />}
            </Field>
          ) : null}
          <ToggleRow id={fid("config.respectRobots")} label="Respect robots.txt" description="Sites use this file to say which pages crawlers should leave alone. Turning it off can get you blocked.">
            {(p) => <Switch {...p} checked={d.respectRobots} onCheckedChange={(v) => set({ respectRobots: v })} />}
          </ToggleRow>
        </AdvancedSettings>
      ) : null}
    </div>
  );
}

const TIME_HINT = "24-hour time, such as 03:30.";

/** Step 3a: when to run, and the optional download window. */
export function ScheduleSection({ d, set, errors }: SectionProps) {
  return (
    <div className="space-y-4">
      <Field id="sf-schedule-kind" label="How often should it run?" error={errors["schedule.kind"]}>
        {(p) => (
          <Select {...p} value={d.schedKind} onChange={(e) => set({ schedKind: e.target.value as Draft["schedKind"] })} data-testid="schedule-kind">
            <option value="manual">Only when I run it</option>
            <option value="hourly">Every hour</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="cron">On a custom schedule (cron)</option>
          </Select>
        )}
      </Field>
      {d.schedKind === "hourly" ? (
        <Field id={fid("schedule.minute")} label="Minutes past the hour" error={errors["schedule.minute"]}>
          {(p) => <NumberInput {...p} className="max-w-32" value={d.minute} onChange={(e) => set({ minute: e.target.value })} />}
        </Field>
      ) : null}
      {d.schedKind === "weekly" ? (
        <Field id="sf-schedule-day" label="Day of the week">
          {(p) => (
            <Select {...p} value={d.dayOfWeek} onChange={(e) => set({ dayOfWeek: e.target.value })} className="max-w-48">
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((n, i) => <option key={n} value={i}>{n}</option>)}
            </Select>
          )}
        </Field>
      ) : null}
      {d.schedKind === "daily" || d.schedKind === "weekly" ? (
        <Field id={fid("schedule.time")} label="Time of day" hint={`${TIME_HINT} Uses ${d.timezone}.`} error={errors["schedule.time"]}>
          {(p) => <Input {...p} type="time" className="max-w-40" value={d.time} onChange={(e) => set({ time: e.target.value })} />}
        </Field>
      ) : null}
      {d.schedKind === "cron" ? (
        <Field id={fid("schedule.cron")} label="Cron expression" hint="Five fields: minute, hour, day of month, month, day of week. Not more often than every five minutes." error={errors["schedule.cron"]}>
          {(p) => <Input {...p} value={d.cron} onChange={(e) => set({ cron: e.target.value })} placeholder="0 3 * * *" spellCheck={false} />}
        </Field>
      ) : null}

      {d.schedKind !== "manual" ? (
        <fieldset className="space-y-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-semibold">Download window</legend>
          <ToggleRow id="sf-window-on" label="Only download between certain hours" description="Outside the window, scheduled runs wait until it opens. A running download pauses when the window closes.">
            {(p) => <Switch {...p} checked={d.windowOn} onCheckedChange={(v) => set({ windowOn: v })} />}
          </ToggleRow>
          {d.windowOn ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={fid("window.start")} label="Opens at" error={errors["window.start"]}>
                  {(p) => <Input {...p} type="time" value={d.winStart} onChange={(e) => set({ winStart: e.target.value })} />}
                </Field>
                <Field id={fid("window.end")} label="Closes at" hint="An end earlier than the start runs past midnight." error={errors["window.end"]}>
                  {(p) => <Input {...p} type="time" value={d.winEnd} onChange={(e) => set({ winEnd: e.target.value })} />}
                </Field>
              </div>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">Days</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1" id={fid("window.days")} tabIndex={-1}>
                  {ALL_DAYS.map((day) => (
                    <div key={day} className="flex items-center gap-2">
                      <Checkbox id={`win-day-${day}`} checked={d.winDays.includes(day)} onCheckedChange={(v) => set({ winDays: v === true ? [...d.winDays, day] : d.winDays.filter((x) => x !== day) })} />
                      <Label htmlFor={`win-day-${day}`} className="text-sm font-normal">{DAY_LABEL[day]}</Label>
                    </div>
                  ))}
                </div>
                {errors["window.days"] ? <p className="mt-1 text-xs font-medium text-destructive">{errors["window.days"]}</p> : null}
              </fieldset>
            </>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}

/** Step 3b: priority, retention, automatic removal, budget, collections. */
export function KeepSection({ d, set, errors, collections, hideCollections }: SectionProps & { collections: (Collection & { depth: number })[]; hideCollections?: boolean }) {
  const manual = collections.filter((c) => c.kind === "manual" || c.kind === "favourites");
  return (
    <div className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">Priority</legend>
        <p className="text-xs text-muted-foreground">How much this source matters when disk space runs short.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {PRIORITIES.map((p) => (
            <Radio
              key={p.value}
              name="source-priority"
              value={p.value}
              checked={d.priority === p.value}
              onChange={() => set({ priority: p.value as Priority, ...(d.evictionTouched ? {} : { automaticEviction: p.value === "P3" || p.value === "P4" }) })}
              label={p.label}
              description={p.explanation}
              testId={`priority-${p.value}`}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold">Retention</legend>
        {d.customRetention ? (
          <p className="text-sm text-muted-foreground">This source uses custom retention rules that were set through the API. They are kept as they are.</p>
        ) : (
          <>
            <Field id="sf-retention-mode" label="Versions to keep" hint={RETENTION_MODES.find((m) => m.value === d.retentionMode)?.hint}>
              {(p) => (
                <Select {...p} value={d.retentionMode} onChange={(e) => set({ retentionMode: e.target.value as Draft["retentionMode"] })} data-testid="retention-mode">
                  {RETENTION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
              )}
            </Field>
            {d.retentionMode === "latest" ? (
              <Field id={fid("retention.count")} label="How many versions" error={errors["retention.count"]}>
                {(p) => <NumberInput {...p} className="max-w-32" value={d.retentionCount} onChange={(e) => set({ retentionCount: e.target.value })} />}
              </Field>
            ) : null}
            {d.retentionMode === "time" ? (
              <Field id={fid("retention.days")} label="Days to keep a version" error={errors["retention.days"]}>
                {(p) => <NumberInput {...p} className="max-w-32" value={d.retentionDays} onChange={(e) => set({ retentionDays: e.target.value })} />}
              </Field>
            ) : null}
            {d.retentionMode === "budget" ? (
              <Field id={fid("retention.bytes")} label="Size to stay within (GB)" error={errors["retention.bytes"]}>
                {(p) => <NumberInput {...p} className="max-w-32" value={d.retentionGb} onChange={(e) => set({ retentionGb: e.target.value })} />}
              </Field>
            ) : null}
          </>
        )}
      </fieldset>

      <div className="space-y-2">
        <ToggleRow id={fid("automaticEviction")} label="Allow automatic removal when space runs short" description={EVICTION_EXPLANATION}>
          {(p) => <Switch {...p} checked={d.automaticEviction} onCheckedChange={(v) => set({ automaticEviction: v, evictionTouched: true })} />}
        </ToggleRow>
        {d.priority === "P1" && d.automaticEviction ? (
          <p className="ml-12 text-xs font-medium" role="note" data-testid="p1-note">Protected (P1) takes precedence: nothing from this source is removed automatically, whatever this switch says.</p>
        ) : null}
      </div>

      <Field id={fid("storageBudgetBytes")} label="Storage budget (GB)" optional hint="A soft limit on how much this source may hold. Leave empty for no budget." error={errors.storageBudgetBytes}>
        {(p) => <NumberInput {...p} className="max-w-32" value={d.budgetGb} onChange={(e) => set({ budgetGb: e.target.value })} />}
      </Field>

      {!hideCollections && manual.length > 0 ? (
        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Add its pages to collections</legend>
          <p className="mb-2 text-xs text-muted-foreground">Optional. Every page this source saves is added to the collections you tick. Nothing is copied.</p>
          <div className="space-y-1">
            {manual.map((c) => (
              <div key={c.id} className="flex items-center gap-2" style={{ paddingLeft: `${c.depth * 1.25}rem` }}>
                <Checkbox id={`src-col-${c.id}`} checked={d.collections.includes(c.id)} onCheckedChange={(v) => set({ collections: v === true ? [...d.collections, c.id] : d.collections.filter((x) => x !== c.id) })} />
                <Label htmlFor={`src-col-${c.id}`} className="text-sm font-normal">{c.name}</Label>
              </div>
            ))}
          </div>
        </fieldset>
      ) : null}

      <ToggleRow id="sf-enabled" label="Switched on" description="A source that is switched off does not run, but keeps its pages and their protection.">
        {(p) => <Switch {...p} checked={d.enabled} onCheckedChange={(v) => set({ enabled: v })} />}
      </ToggleRow>
    </div>
  );
}

/** The rest of the behaviour settings. Rarely worth changing. */
export function MoreAdvanced({ d, set, errors, ceil, open, onOpenChange, web, crawl }: SectionProps & { open: boolean; onOpenChange: (o: boolean) => void; web: boolean; crawl: boolean }) {
  const changed = [d.concurrency, d.perDomainDelayMs, d.retries, d.renderMode, d.versioningMode, d.maxLinksPerPage, d.userAgentSuffix, d.sitemapMaxDepth].filter(Boolean).length + (d.missedRunPolicy !== "run_once" ? 1 : 0);
  return (
    <AdvancedSettings title="Advanced settings: behaviour" open={open} onOpenChange={onOpenChange} changed={changed} id="adv-more">
      <Field id={fid("schedule.timezone")} label="Time zone for the schedule" hint="A name such as Europe/London." error={errors["schedule.timezone"]}>
        {(p) => <Input {...p} className="max-w-xs" value={d.timezone} onChange={(e) => set({ timezone: e.target.value })} spellCheck={false} />}
      </Field>
      <Field id="sf-missed" label="If a scheduled run is missed" hint="For example when the server was off.">
        {(p) => (
          <Select {...p} className="max-w-xs" value={d.missedRunPolicy} onChange={(e) => set({ missedRunPolicy: e.target.value as Draft["missedRunPolicy"] })}>
            <option value="run_once">Run once when it can</option>
            <option value="skip">Skip it</option>
          </Select>
        )}
      </Field>
      {web ? (
        <>
          <Field id={fid("config.versioning")} label="When to keep a new version" hint="Default: only when the page has changed." error={errors["config.versioning"] ?? errors["config.versioning.n"]}>
            {(p) => (
              <Select {...p} className="max-w-xs" value={d.versioningMode} onChange={(e) => set({ versioningMode: e.target.value as Draft["versioningMode"] })}>
                <option value="">Default: when it has changed</option>
                <option value="on_change">When it has changed</option>
                <option value="all">Every time</option>
                <option value="latest_only">Latest only</option>
                <option value="last_n">The last few</option>
                <option value="period">One per day, week or month</option>
              </Select>
            )}
          </Field>
          {d.versioningMode === "last_n" ? (
            <Field id={fid("config.versioning.n")} label="Number of versions" error={errors["config.versioning.n"]}>
              {(p) => <NumberInput {...p} className="max-w-32" value={d.versioningN} onChange={(e) => set({ versioningN: e.target.value })} />}
            </Field>
          ) : null}
          {d.versioningMode === "period" ? (
            <Field id="sf-versioning-period" label="One version per">
              {(p) => (
                <Select {...p} className="max-w-xs" value={d.versioningPeriod} onChange={(e) => set({ versioningPeriod: e.target.value as Draft["versioningPeriod"] })}>
                  <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
                </Select>
              )}
            </Field>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={fid("config.concurrency")} label="Requests at once" hint={ceil ? `Up to ${ceil.concurrency}.` : undefined} optional error={errors["config.concurrency"]}>
              {(p) => <NumberInput {...p} value={d.concurrency} onChange={(e) => set({ concurrency: e.target.value })} placeholder="Default" />}
            </Field>
            <Field id={fid("config.perDomainDelayMs")} label="Delay between requests (ms)" hint={ceil ? `At least ${ceil.minPerDomainDelayMs} ms.` : undefined} optional error={errors["config.perDomainDelayMs"]}>
              {(p) => <NumberInput {...p} value={d.perDomainDelayMs} onChange={(e) => set({ perDomainDelayMs: e.target.value })} placeholder="Default" />}
            </Field>
            <Field id={fid("config.retries")} label="Retries" hint={ceil ? `Up to ${ceil.retries}.` : undefined} optional error={errors["config.retries"]}>
              {(p) => <NumberInput {...p} value={d.retries} onChange={(e) => set({ retries: e.target.value })} placeholder="Default" />}
            </Field>
          </div>
          <Field id={fid("config.renderMode")} label="Pages that need scripts to show their content" hint="Rendering needs the optional renderer. Default: never." error={errors["config.renderMode"]}>
            {(p) => (
              <Select {...p} className="max-w-xs" value={d.renderMode} onChange={(e) => set({ renderMode: e.target.value as Draft["renderMode"] })}>
                <option value="">Default: never render</option>
                <option value="auto">Render when the page looks empty</option>
                <option value="always">Always render</option>
              </Select>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {crawl ? (
              <Field id={fid("config.maxLinksPerPage")} label="Links followed per page" optional error={errors["config.maxLinksPerPage"]}>
                {(p) => <NumberInput {...p} value={d.maxLinksPerPage} onChange={(e) => set({ maxLinksPerPage: e.target.value })} placeholder="Default (500)" />}
              </Field>
            ) : null}
            {d.type === "sitemap" ? (
              <Field id={fid("config.sitemapMaxDepth")} label="Sitemap nesting" hint="How many levels of sitemap index files to follow." optional error={errors["config.sitemapMaxDepth"]}>
                {(p) => <NumberInput {...p} value={d.sitemapMaxDepth} onChange={(e) => set({ sitemapMaxDepth: e.target.value })} placeholder="Default (3)" />}
              </Field>
            ) : null}
            <Field id={fid("config.userAgentSuffix")} label="Text added to the crawler's name" hint="Lets a site owner recognise you." optional error={errors["config.userAgentSuffix"]}>
              {(p) => <Input {...p} value={d.userAgentSuffix} onChange={(e) => set({ userAgentSuffix: e.target.value })} maxLength={60} />}
            </Field>
          </div>
        </>
      ) : null}
    </AdvancedSettings>
  );
}
