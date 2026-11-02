"use client";

import * as React from "react";
import { FolderPlus } from "lucide-react";
import { errorMessage, post } from "@/lib/api";
import type { Collection } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/common/form";
import { useToast } from "@/components/ui/toast";
import { useCollections } from "./hooks";

const NEW = "__new__";

/** Adds pages to a collection (existing, or a new one made on the spot). Auto collections are filled by their rule, so they are not offered. */
export function AddToCollectionDialog({
  pageIds,
  open,
  onClose,
  onDone,
}: {
  pageIds: string[];
  open: boolean;
  onClose: () => void;
  onDone?: (collectionName: string) => void;
}) {
  const cols = useCollections();
  const { toast } = useToast();
  const [target, setTarget] = React.useState("");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const choices = cols.flat.filter((c) => c.kind === "manual" || c.kind === "favourites");

  React.useEffect(() => {
    if (open) {
      setError(null);
      setName("");
      setTarget("");
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) {
      setError("Choose a collection.");
      return;
    }
    if (target === NEW && !name.trim()) {
      setError("Enter a name for the new collection.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let id = target;
      let label = choices.find((c) => c.id === target)?.name ?? "";
      if (target === NEW) {
        const created = await post<Collection>("/api/collections", { name: name.trim(), kind: "manual" });
        id = created.id;
        label = created.name;
      }
      for (let i = 0; i < pageIds.length; i += 500) {
        await post(`/api/collections/${id}/items`, { add: pageIds.slice(i, i + 500).map((pageId) => ({ pageId })) });
      }
      toast({ title: `Added to ${label}`, description: `${pageIds.length} ${pageIds.length === 1 ? "page" : "pages"}`, variant: "success" });
      void cols.mutate();
      onDone?.(label);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby="add-col-desc">
        <div>
          <DialogTitle>Add to a collection</DialogTitle>
          <DialogDescription id="add-col-desc" className="mt-1">
            {pageIds.length} {pageIds.length === 1 ? "page" : "pages"} will be added. The pages are not copied, so this uses no extra space.
          </DialogDescription>
        </div>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field id="add-col-target" label="Collection" error={error && !error.startsWith("Enter") ? error : null}>
            {(p) => (
              <Select {...p} value={target} onChange={(e) => setTarget(e.target.value)} data-testid="add-col-target">
                <option value="">Choose a collection</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {"  ".repeat(c.depth)}{c.name}
                  </option>
                ))}
                <option value={NEW}>New collection…</option>
              </Select>
            )}
          </Field>
          {target === NEW ? (
            <Field id="add-col-name" label="Name of the new collection" error={error?.startsWith("Enter") ? error : null}>
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />}
            </Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy} data-testid="add-col-confirm">
              <FolderPlus aria-hidden="true" /> Add to collection
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
