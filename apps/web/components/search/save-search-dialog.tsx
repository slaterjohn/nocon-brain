"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, fieldErrors, post } from "@/lib/api";
import { filtersFromState, readSaved, type SavedSearch, type SearchState } from "@/lib/search";

/** Saves the words and filters of the current search under a name. */
export function SaveSearchDialog({
  open, onOpenChange, state, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: SearchState;
  onSaved: (s: SavedSearch) => void;
}) {
  const [name, setName] = React.useState(state.q);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setName(state.q);
      setError("");
    }
  }, [open, state.q]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter a name for this search.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const raw = await post<unknown>("/api/search/saved", { name: name.trim(), query: state.q, filters: filtersFromState(state), scope: state.scope, includeOnline: state.scope === "all" || state.scope === "online" });
      const saved = readSaved(raw) ?? { id: "", name: name.trim(), query: state.q };
      onOpenChange(false);
      onSaved(saved);
    } catch (err) {
      setError(fieldErrors(err).name ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="save-search-desc">
        <div>
          <DialogTitle>Save this search</DialogTitle>
          <DialogDescription id="save-search-desc" className="mt-1">Keeps the words and filters so you can run it again from the Search area.</DialogDescription>
        </div>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="save-search-name" className="mb-1 block">Name</Label>
            <Input id="save-search-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? "save-search-error" : undefined} autoComplete="off" />
            {error ? <p id="save-search-error" role="alert" className="mt-1 text-sm text-destructive">{error}</p> : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy} data-testid="save-search-confirm">Save search</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
