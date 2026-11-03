"use client";

import * as React from "react";
import { Library, Loader2 } from "lucide-react";
import { del, errorMessage, get, patch, post, useApi } from "@/lib/api";
import {
  emptyImportDraft, fileOutcome, importBody, importErrors, referenceLines, stateOf, validateImport,
  type FieldErrors, type ImportDraft, type RemovalPlan, type ZimPackage,
} from "@/lib/zim";
import type { Priority } from "@/lib/types";
import type { StorageOverview } from "@/lib/storage";
import { PRIORITIES } from "@/lib/library-copy";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { ErrorSummary, type SummaryItem } from "@/components/common/error-summary";
import { Field, FormError } from "@/components/common/form";
import { Notice, useReturnFocus } from "@/components/storage/shared";

export function StateBadge({ pkg }: { pkg: Pick<ZimPackage, "state" | "stateDetail"> }) {
  const s = stateOf(pkg);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Badge variant={s.variant} data-testid="package-state" data-state={pkg.state}>{s.label}</Badge>
      {pkg.stateDetail && (pkg.state === "degraded" || pkg.state === "missing") ? <span className="max-w-56 text-xs text-muted-foreground" data-testid="package-state-detail">{pkg.stateDetail}</span> : null}
    </span>
  );
}

/** The package's own icon. Same-origin only; nothing is ever fetched from the web. */
export function PackageIcon({ pkg, className = "size-8" }: { pkg: Pick<ZimPackage, "illustrationUrl">; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  const src = pkg.illustrationUrl && pkg.illustrationUrl.startsWith("/") && !pkg.illustrationUrl.startsWith("//") ? pkg.illustrationUrl : null;
  if (src && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" width={48} height={48} className={`${className} shrink-0 rounded-sm`} onError={() => setFailed(true)} data-testid="package-icon" />;
  }
  return <Library className={`${className} shrink-0 p-1 text-muted-foreground`} aria-hidden="true" />;
}

/** Licence and credit line for a package, in words. */
export function LicenceLine({ pkg }: { pkg: Pick<ZimPackage, "license" | "attribution"> }) {
  const name = pkg.license.name;
  return (
    <span data-testid="package-licence">
      {name ? (pkg.license.url && /^https?:\/\//i.test(pkg.license.url) ? <a href={pkg.license.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{name}<span className="sr-only"> (opens in a new browser tab)</span></a> : name) : "Licence not stated"}
      {name && !pkg.license.known ? <span className="text-muted-foreground"> (the file did not say)</span> : null}
      {pkg.attribution ? <span className="block text-xs text-muted-foreground">{pkg.attribution}</span> : null}
    </span>
  );
}

/** Priority as a native select that saves on change. */
export function PrioritySelect({ pkg, onChanged }: { pkg: ZimPackage; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  async function change(value: Priority) {
    setBusy(true);
    try {
      await patch(`/api/zim/packages/${pkg.id}`, { priority: value });
      toast({ title: "Priority changed", description: `${pkg.title} is now ${PRIORITIES.find((p) => p.value === value)?.label}.`, variant: "success" });
      onChanged();
    } catch (e) {
      toast({ title: "Couldn't change the priority", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Select aria-label={`Priority of ${pkg.title}`} value={pkg.priority} disabled={busy} onChange={(e) => void change(e.target.value as Priority)} className="w-44" data-testid="package-priority">
      {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
    </Select>
  );
}

// ---- Add a package ----

const fid = (k: string) => `zimadd-${k}`;

export function AddPackageDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (pkg: ZimPackage) => void }) {
  const { toast } = useToast();
  const [d, setD] = React.useState<ImportDraft>(emptyImportDraft);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [general, setGeneral] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [advOpen, setAdvOpen] = React.useState(false);
  const [copying, setCopying] = React.useState<ZimPackage | null>(null);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const [tick, setTick] = React.useState(0);
  const returnFocus = useReturnFocus(open);
  const overview = useApi<StorageOverview>("/api/storage", { enabled: open && d.copy });
  const volumes = (overview.data?.volumes ?? []).filter((v) => v.state === "online");

  React.useEffect(() => {
    if (!open) return;
    setD(emptyImportDraft());
    setErrors({});
    setGeneral(null);
    setAdvOpen(false);
    setCopying(null);
    setBusy(false);
  }, [open]);

  React.useEffect(() => {
    if (tick) summaryRef.current?.focus();
  }, [tick]);

  // A copy runs in the background. Follow it until the package is ready, so the dialog can say when it is done.
  React.useEffect(() => {
    if (!copying || copying.state !== "importing") return;
    let live = true;
    const poll = setInterval(async () => {
      try {
        const p = await get<ZimPackage>(`/api/zim/packages/${copying.id}`);
        if (!live || p.state === "importing") return;
        setCopying(p);
        onAdded(p);
        toast({ title: p.state === "ready" ? "Package copied" : "The copy needs attention", description: p.title, variant: p.state === "ready" ? "success" : "error" });
      } catch {
        /* try again on the next tick */
      }
    }, 1500);
    return () => {
      live = false;
      clearInterval(poll);
    };
  }, [copying, onAdded, toast]);

  const set = (patch: Partial<ImportDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      return next;
    });
  };

  function fail(fields: FieldErrors, more: string | null) {
    setErrors(fields);
    setGeneral(more);
    if (["licenseName", "licenseUrl", "attribution"].some((k) => fields[k])) setAdvOpen(true);
    setTick((t) => t + 1);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const local = validateImport(d);
    if (Object.keys(local).length) return fail(local, null);
    setBusy(true);
    try {
      const pkg = await post<ZimPackage>("/api/zim/packages/import", importBody(d));
      if (pkg.state === "importing") {
        setCopying(pkg);
        onAdded(pkg);
      } else {
        toast({ title: "Package added", description: pkg.title, variant: "success" });
        onAdded(pkg);
        onClose();
      }
    } catch (err) {
      const m = importErrors(err);
      fail(m.fields, m.general);
    } finally {
      setBusy(false);
    }
  }

  const summary: SummaryItem[] = [
    ...Object.entries(errors).map(([k, message]) => ({ id: fid(k), message })),
    ...(general ? [{ id: fid("path"), message: general }] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl" data-testid="add-package-dialog" onCloseAutoFocus={returnFocus}>
        <DialogTitle>Add a knowledge package</DialogTitle>
        <DialogDescription>
          A package is a ZIM file, such as an offline Wikipedia. Put the file on the machine running NoConBrain, inside a folder the server has been allowed to read, then enter its path.
        </DialogDescription>
        {copying ? (
          <div className="space-y-4" role="status" aria-live="polite" data-testid="copy-progress">
            {copying.state === "importing" ? (
              <>
                <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> Copying {copying.title} ({formatBytes(copying.sizeBytes)}). A large file can take several minutes.</p>
                <p className="text-sm text-muted-foreground">You can close this. The copy carries on, and the package shows as Copying in the list until it is ready.</p>
              </>
            ) : (
              <p className="text-sm" data-testid="copy-done">{copying.state === "ready" ? `${copying.title} is copied and ready.` : `${copying.title} was copied but is ${stateOf(copying).label.toLowerCase()}. ${copying.stateDetail ?? ""}`}</p>
            )}
            <div className="flex justify-end"><Button onClick={onClose} data-testid="add-close">Close</Button></div>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
            <ErrorSummary ref={summaryRef} items={summary} />
            <Field id={fid("path")} label="Path to the .zim file" hint="The full path on the machine running NoConBrain, for example /mnt/library/wikipedia_en_all_maxi.zim." error={errors.path}>
              {(p) => <Input {...p} value={d.path} onChange={(e) => set({ path: e.target.value })} autoComplete="off" spellCheck={false} data-testid="add-path" />}
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Where the file is kept</legend>
              <div className="flex items-start gap-3 rounded-lg border p-3">
                <input type="radio" id={fid("inplace")} name="zim-store" className="mt-1 size-4 accent-[var(--primary)]" checked={!d.copy} onChange={() => set({ copy: false })} data-testid="add-in-place" />
                <div><Label htmlFor={fid("inplace")}>Read it where it is</Label><p className="text-xs text-muted-foreground">Nothing is copied. The file stays on disk if the package is removed later.</p></div>
              </div>
              <div className="flex items-start gap-3 rounded-lg border p-3">
                <input type="radio" id={fid("copy")} name="zim-store" className="mt-1 size-4 accent-[var(--primary)]" checked={d.copy} onChange={() => set({ copy: true })} data-testid="add-copy" />
                <div><Label htmlFor={fid("copy")}>Copy it into NoConBrain&apos;s storage</Label><p className="text-xs text-muted-foreground">Uses space on a volume and takes a while for a large file. The original is left alone, and the copy is deleted if the package is removed.</p></div>
              </div>
            </fieldset>
            {d.copy ? (
              <Field id={fid("volumeId")} label="Volume for the copy" optional hint="Leave on the default to use the default volume." error={errors.volumeId}>
                {(p) => (
                  <Select {...p} value={d.volumeId} onChange={(e) => set({ volumeId: e.target.value })}>
                    <option value="">Default volume</option>
                    {volumes.map((v) => <option key={v.id} value={v.id}>{v.name} ({formatBytes(v.availableBytes)} free)</option>)}
                  </Select>
                )}
              </Field>
            ) : null}
            <Field id={fid("priority")} label="Priority" hint="Packages are never removed automatically, whatever the priority. It still counts in the storage figures.">
              {(p) => <Select {...p} value={d.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>{PRIORITIES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>}
            </Field>
            <AdvancedSettings open={advOpen} onOpenChange={setAdvOpen} id="zimadd-adv" title="Advanced settings">
              <div className="flex items-center gap-2"><Checkbox id={fid("search")} checked={d.enabledForSearch} onCheckedChange={(v) => set({ enabledForSearch: v === true })} /><Label htmlFor={fid("search")} className="font-normal">Search this package</Label></div>
              <div className="flex items-center gap-2"><Checkbox id={fid("source")} checked={d.createSource} onCheckedChange={(v) => set({ createSource: v === true })} /><Label htmlFor={fid("source")} className="font-normal">Create a source for it in the Library</Label></div>
              <p className="text-xs text-muted-foreground">The licence and credit line are read from the file. Fill these in only when the file does not state them.</p>
              <Field id={fid("licenseName")} label="Licence name" optional error={errors.licenseName}>{(p) => <Input {...p} value={d.licenseName} onChange={(e) => set({ licenseName: e.target.value })} autoComplete="off" />}</Field>
              <Field id={fid("licenseUrl")} label="Licence address" optional error={errors.licenseUrl}>{(p) => <Input {...p} value={d.licenseUrl} onChange={(e) => set({ licenseUrl: e.target.value })} autoComplete="off" inputMode="url" />}</Field>
              <Field id={fid("attribution")} label="Credit line" optional hint="Shown with the package's articles." error={errors.attribution}>{(p) => <Input {...p} value={d.attribution} onChange={(e) => set({ attribution: e.target.value })} autoComplete="off" />}</Field>
            </AdvancedSettings>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy} data-testid="add-submit">{busy ? "Adding…" : d.copy ? "Copy and add" : "Add package"}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- Remove a package ----

interface DryRun { removed: boolean; plan: RemovalPlan }

/**
 * Removal with the dry run first: the list of what refers to the package, what happens to the file, and a confirmation when
 * anything refers to it. A file added in place stays on disk; only a copy NoConBrain made is deleted.
 */
export function RemovePackageDialog({ pkg, onClose, onRemoved }: { pkg: ZimPackage | null; onClose: () => void; onRemoved: () => void }) {
  const { toast } = useToast();
  const [plan, setPlan] = React.useState<RemovalPlan | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const returnFocus = useReturnFocus(pkg !== null);
  const id = pkg?.id;

  React.useEffect(() => {
    setPlan(null);
    setError(null);
    setAck(false);
    if (!id) return;
    let live = true;
    del<DryRun>(`/api/zim/packages/${id}?dryRun=true`)
      .then((r) => live && setPlan(r.plan))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [id]);

  async function remove() {
    if (!pkg || !plan) return;
    setBusy(true);
    try {
      await del(`/api/zim/packages/${pkg.id}?confirm=${plan.needsConfirmation ? "true" : "false"}`);
      toast({ title: "Package removed", description: plan.deletesFile ? `${pkg.title}. The copy was deleted.` : `${pkg.title}. The file was left on disk.`, variant: "success" });
      onRemoved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const lines = plan ? referenceLines(plan.references) : [];
  return (
    <Dialog open={pkg !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="remove-package-dialog" onCloseAutoFocus={returnFocus}>
        <DialogTitle>Remove {pkg?.title}?</DialogTitle>
        <DialogDescription asChild>
          <div className="space-y-2" role="status" aria-live="polite">
            {!plan && !error ? <p>Checking what refers to this package…</p> : null}
            {plan ? <p data-testid="remove-file-outcome">{fileOutcome(plan, (n) => formatBytes(n))}</p> : null}
          </div>
        </DialogDescription>
        {error ? <FormError message={error} /> : null}
        {plan && lines.length > 0 ? (
          <div className="space-y-2" data-testid="remove-references">
            <h3 className="text-sm font-semibold">Removing it also changes</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm">{lines.map((l) => <li key={l.key} data-testid={`ref-${l.key}`}>{l.label}</li>)}</ul>
            {plan.references.bookmarks.items.length ? (
              <p className="text-xs text-muted-foreground">Bookmarks: {plan.references.bookmarks.items.map((b) => b.title).join(", ")}{plan.references.bookmarks.count > plan.references.bookmarks.items.length ? " and more" : ""}.</p>
            ) : null}
            <div className="flex items-start gap-2 pt-1">
              <Checkbox id="remove-ack" checked={ack} onCheckedChange={(v) => setAck(v === true)} data-testid="remove-ack" />
              <Label htmlFor="remove-ack" className="font-normal">I understand these will be changed or deleted.</Label>
            </div>
          </div>
        ) : null}
        {plan && lines.length === 0 ? <Notice>Nothing refers to this package, so nothing else changes.</Notice> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => void remove()} disabled={!plan || busy || (lines.length > 0 && !ack)} data-testid="remove-confirm">
            {busy ? "Removing…" : lines.length ? "Remove package and references" : "Remove package"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

