"use client";

import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { SHORTCUTS } from "@/lib/shortcuts";
import { api, errorMessage, get } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import type { BrowserSettings } from "@/lib/types";

const GROUPS = ["Tabs", "Address bar and history", "This page", "General"] as const;

/** What the marks on links inside saved pages mean. Mirrors the styles the archive listener adds (packages/render). */
export const LINK_LEGEND: { state: string; label: string; mark: string; className: string; text: string }[] = [
  { state: "cached", label: "Saved", mark: "", className: "underline", text: "Opens the saved copy, also without internet." },
  { state: "partial", label: "Partly saved", mark: " ◐", className: "underline decoration-dotted", text: "A saved copy that is missing some files." },
  { state: "queued", label: "Waiting to be saved", mark: " ⏳", className: "underline decoration-dashed", text: "Queued. It will be saved soon." },
  { state: "live-only", label: "Live only", mark: " ↗", className: "underline decoration-dotted", text: "Not saved. Open the live site, or save it for offline." },
  { state: "unavailable", label: "Not available", mark: "", className: "line-through opacity-70", text: "Not saved, and there is no internet to get it." },
];

export function LinkStateLegend({ className }: { className?: string }) {
  return (
    <dl className={className} data-testid="link-legend">
      {LINK_LEGEND.map((l) => (
        <div key={l.state} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
          <dt className="w-40 shrink-0 text-sm">
            <span className={l.className} aria-hidden="true">
              example link{l.mark}
            </span>
            <span className="sr-only">{l.label}</span>
          </dt>
          <dd className="min-w-0 flex-1 text-sm text-muted-foreground">
            <strong className="font-medium text-foreground">{l.label}.</strong> {l.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** `browser.showLinkStates`: whether the archive marks links in saved pages by what they lead to. Applies the next time a page loads. */
function LinkStatesSwitch() {
  const { toast } = useToast();
  const [on, setOn] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let live = true;
    get<{ browser: BrowserSettings }>("/api/settings")
      .then((s) => live && setOn(s.browser.showLinkStates))
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  async function change(v: boolean) {
    setOn(v);
    try {
      await api("/api/settings", { method: "PATCH", body: { browser: { showLinkStates: v } } });
    } catch (e) {
      setOn(!v);
      toast({ title: "Couldn't change the setting", description: errorMessage(e), variant: "error" });
    }
  }
  return (
    <div className="mb-2 flex items-center gap-3 rounded-md border p-3">
      <Switch id="show-link-states" checked={on ?? true} disabled={on === null} onCheckedChange={(v) => void change(v)} />
      <Label htmlFor="show-link-states" className="text-sm leading-snug">
        Mark links in saved pages (applies when a page is opened or reloaded)
      </Label>
    </div>
  );
}

export function ShortcutsDialog({
  open, onOpenChange, singleKeys, onSingleKeys, returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  singleKeys: boolean;
  onSingleKeys: (on: boolean) => void;
  /** The element that had focus when the dialog opened; it gets focus back on close. */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        aria-describedby="shortcuts-desc"
        onCloseAutoFocus={(e) => {
          const el = returnFocusTo?.current;
          if (el && el.isConnected) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        <div>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription id="shortcuts-desc" className="mt-1">
            These avoid the keys your browser keeps for itself (Ctrl or Cmd with T, W, N, L, R, F and D, and Alt with the arrow keys). On a Mac,
            Alt is the Option key. Ctrl+F or Cmd+F still searches the page, including inside a saved page.
          </DialogDescription>
        </div>
        {GROUPS.map((g) => (
          <section key={g} aria-labelledby={`sc-${g.replace(/\W+/g, "-")}`}>
            <h3 id={`sc-${g.replace(/\W+/g, "-")}`} className="mb-1 text-sm font-semibold">
              {g}
            </h3>
            <ul className="divide-y rounded-md border">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm">
                  <span>{s.label}</span>
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{s.keys}</kbd>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <div className="flex items-center gap-3 rounded-md border p-3">
          <Switch id="single-keys" checked={singleKeys} onCheckedChange={onSingleKeys} />
          <Label htmlFor="single-keys" className="text-sm">
            Single-key shortcuts ("/" and "?")
          </Label>
        </div>
        <section aria-labelledby="legend-h">
          <h3 id="legend-h" className="mb-1 text-sm font-semibold">
            Links in saved pages
          </h3>
          <LinkStatesSwitch />
          <LinkStateLegend />
        </section>
      </DialogContent>
    </Dialog>
  );
}
