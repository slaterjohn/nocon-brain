"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { ApiError, errorMessage, fieldErrors, patch, post, useApi } from "@/lib/api";
import type { Collection, CollectionRule, Priority, RuleCondition } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field, FormError } from "@/components/common/form";
import { ErrorSummary } from "@/components/common/error-summary";
import { PRIORITIES } from "@/lib/library-copy";
import { CollectionIcon, iconLabel } from "./collection-icon";
import { useSources } from "./hooks";

export function IconPicker({ value, onChange, icons, group = "collection-icon" }: { value: string; onChange: (v: string) => void; icons: string[]; group?: string }) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium">Icon</legend>
      <div className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-10" data-testid="icon-picker">
        {icons.map((name) => (
          <label key={name} className="relative">
            <input type="radio" name={group} value={name} checked={value === name} onChange={() => onChange(name)} className="peer sr-only" />
            <span className="flex size-8 items-center justify-center rounded-md border border-transparent hover:bg-accent peer-checked:border-primary peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--ring)]">
              <CollectionIcon name={name} />
              <span className="sr-only">{iconLabel(name)}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Rule editor for an automatic collection: match all or any of a few conditions. */
export function RuleEditor({ rule, onChange, error }: { rule: CollectionRule; onChange: (r: CollectionRule) => void; error?: string }) {
  const sources = useSources();
  const setCond = (i: number, c: Partial<RuleCondition>) => onChange({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  return (
    <fieldset className="space-y-3 rounded-lg border p-3" data-testid="rule-editor">
      <legend className="px-1 text-sm font-semibold">Rule</legend>
      <p className="text-xs text-muted-foreground">Pages that match are added automatically, now and whenever a new page is saved.</p>
      <div className="max-w-xs">
        <Label htmlFor="rule-match" className="mb-1 block text-sm">A page is added when it matches</Label>
        <Select id="rule-match" value={rule.match} onChange={(e) => onChange({ ...rule, match: e.target.value as "all" | "any" })}>
          <option value="all">all of the conditions</option>
          <option value="any">any of the conditions</option>
        </Select>
      </div>
      <ul className="space-y-2">
        {rule.conditions.map((c, i) => (
          <li key={i} className="flex flex-wrap items-end gap-2" data-testid="rule-condition">
            <div>
              <Label htmlFor={`rule-field-${i}`} className="mb-1 block text-xs">Condition {i + 1}</Label>
              <Select id={`rule-field-${i}`} value={c.field} onChange={(e) => setCond(i, { field: e.target.value as RuleCondition["field"], value: "" })}>
                <option value="domain">Site is</option>
                <option value="source">Source is</option>
                <option value="title">Title contains</option>
              </Select>
            </div>
            <div className="min-w-48 flex-1">
              <Label htmlFor={`rule-value-${i}`} className="mb-1 block text-xs">Value for condition {i + 1}</Label>
              {c.field === "source" ? (
                <Select id={`rule-value-${i}`} value={c.value} onChange={(e) => setCond(i, { value: e.target.value })}>
                  <option value="">Choose a source</option>
                  {sources.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              ) : (
                <Input id={`rule-value-${i}`} value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder={c.field === "domain" ? "example.org" : "a word in the title"} />
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })} disabled={rule.conditions.length <= 1}>
              <X aria-hidden="true" /> Remove<span className="sr-only"> condition {i + 1}</span>
            </Button>
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" onClick={() => onChange({ ...rule, conditions: [...rule.conditions, { field: "domain", value: "" }] })} disabled={rule.conditions.length >= 10}>
        <Plus aria-hidden="true" /> Add a condition
      </Button>
      {error ? <p className="text-xs font-medium text-destructive" role="alert">{error}</p> : null}
    </fieldset>
  );
}

/** Create or edit a collection. Parent is chosen in "Move" for an existing one, and here for a new one. */
export function CollectionForm({
  initial, parentId, onSaved, onCancel, parentChoices, idPrefix = "col",
}: {
  idPrefix?: string;
  initial?: Collection;
  parentId?: string | null;
  onSaved: (c: Collection) => void;
  onCancel?: () => void;
  parentChoices?: (Collection & { depth: number })[];
}) {
  const icons = useApi<{ items: string[] }>("/api/collections/icons");
  const [name, setName] = React.useState(initial?.name ?? "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  const [icon, setIcon] = React.useState(initial?.icon ?? "folder");
  const [kind, setKind] = React.useState<"manual" | "auto">(initial?.kind === "auto" ? "auto" : "manual");
  const [floor, setFloor] = React.useState<Priority | "">(initial?.priorityFloor ?? "");
  const [parent, setParent] = React.useState<string>(parentId ?? "");
  const [rule, setRule] = React.useState<CollectionRule>(initial?.rule ?? { match: "all", conditions: [{ field: "domain", value: "" }] });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [general, setGeneral] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const summary = React.useRef<HTMLDivElement>(null);
  const editing = !!initial;
  const isAuto = (editing ? initial!.kind : kind) === "auto";

  React.useEffect(() => {
    if (initial) {
      setName(initial.name); setDescription(initial.description ?? ""); setIcon(initial.icon); setFloor(initial.priorityFloor ?? "");
      if (initial.rule) setRule(initial.rule);
      setErrors({}); setGeneral(null);
    }
  }, [initial]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Enter a name for the collection.";
    if (isAuto && rule.conditions.some((c) => !c.value.trim())) errs.rule = "Fill in every condition, or remove the ones you don't need.";
    if (Object.keys(errs).length) {
      setErrors(errs);
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    setBusy(true);
    setErrors({});
    setGeneral(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), icon, priorityFloor: floor || null };
      if (editing) body.description = description.trim() || null;
      else if (description.trim()) body.description = description.trim();
      if (isAuto) body.rule = rule;
      const saved = editing
        ? await patch<Collection>(`/api/collections/${initial!.id}`, body)
        : await post<Collection>("/api/collections", { ...body, kind, parentId: parent || null });
      onSaved(saved);
    } catch (err) {
      const fe = fieldErrors(err);
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(fe)) mapped[k.startsWith("rule") ? "rule" : k] = v;
      setErrors(mapped);
      if (!Object.keys(mapped).length) setGeneral(errorMessage(err instanceof ApiError ? err : err));
      setTimeout(() => summary.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  }

  const items = Object.entries(errors).map(([k, message]) => ({ id: k === "rule" ? "rule-match" : `${idPrefix}-${k}`, message }));
  return (
    <form onSubmit={submit} noValidate className="space-y-4" data-testid="collection-form">
      <ErrorSummary ref={summary} items={items} />
      <FormError message={general} />
      <Field id={`${idPrefix}-name`} label="Name" error={errors.name}>
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" autoFocus={!editing} />}
      </Field>
      <Field id={`${idPrefix}-description`} label="Description" optional>
        {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />}
      </Field>
      {!editing ? (
        <>
          <Field id={`${idPrefix}-kind`} label="Kind" hint={kind === "auto" ? "Filled by a rule. You can't add pages by hand." : "You add pages by hand."}>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as "manual" | "auto")}>
                <option value="manual">Manual</option>
                <option value="auto">Automatic (by rule)</option>
              </Select>
            )}
          </Field>
          {parentChoices ? (
            <Field id={`${idPrefix}-parent`} label="Inside" hint="Collections can be nested up to 8 levels deep.">
              {(p) => (
                <Select {...p} value={parent} onChange={(e) => setParent(e.target.value)}>
                  <option value="">Top level</option>
                  {parentChoices.map((c) => <option key={c.id} value={c.id}>{"  ".repeat(c.depth)}{c.name}</option>)}
                </Select>
              )}
            </Field>
          ) : null}
        </>
      ) : null}
      <IconPicker value={icon} onChange={setIcon} icons={icons.data?.items ?? [icon]} group={`${idPrefix}-icon`} />
      <Field id={`${idPrefix}-priorityFloor`} label="Priority floor" optional hint="Pages in this collection count as at least this priority. It protects them more; it never lowers a page's priority.">
        {(p) => (
          <Select {...p} value={floor} onChange={(e) => setFloor(e.target.value as Priority | "")} className="max-w-xs" data-testid="priority-floor">
            <option value="">None</option>
            {PRIORITIES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </Select>
        )}
      </Field>
      {isAuto ? <RuleEditor rule={rule} onChange={setRule} error={errors.rule} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy} data-testid="save-collection">{editing ? "Save changes" : "Create collection"}</Button>
        {onCancel ? <Button variant="outline" onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}
