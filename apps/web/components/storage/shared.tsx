"use client";

import * as React from "react";
import { AlertTriangle, Info, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes } from "@/lib/utils";
import { asPriority, barScale, barWidths, usageLabel, type AnyPriority, type UsageReport, type UsageRow } from "@/lib/storage";
import type { Priority } from "@/lib/types";

/** Short statement that has to appear wherever eviction is discussed. */
export function ProtectedNote({ className }: { className?: string }) {
  return (
    <p className={`flex items-start gap-2 text-sm ${className ?? ""}`} data-testid="protected-note">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      <span>Protected (P1) content is never removed automatically. No setting changes that.</span>
    </p>
  );
}

export function Notice({ tone = "info", title, children, testId }: { tone?: "info" | "warning"; title?: string; children: React.ReactNode; testId?: string }) {
  const Icon = tone === "warning" ? AlertTriangle : Info;
  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${tone === "warning" ? "border-warning/60" : ""}`} data-testid={testId}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "warning" ? "text-warning" : "text-primary"}`} aria-hidden="true" />
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        <div className={title ? "text-muted-foreground" : ""}>{children}</div>
      </div>
    </div>
  );
}

const PRIORITY_VARIANT: Record<Priority, "success" | "warning" | "secondary" | "outline"> = { P1: "success", P2: "warning", P3: "secondary", P4: "outline" };
const PRIORITY_SHORT: Record<Priority, string> = { P1: "P1 Protected", P2: "P2 Important", P3: "P3 Standard", P4: "P4 Opportunistic" };
export function PriorityBadge({ priority: raw, surplus }: { priority: AnyPriority | null; surplus?: boolean }) {
  const priority = asPriority(raw);
  if (!priority) return <Badge variant="outline">No priority</Badge>;
  return <Badge variant={PRIORITY_VARIANT[priority]}>{PRIORITY_SHORT[priority]}{surplus ? " (surplus)" : ""}</Badge>;
}

/**
 * Dialogs here are opened by state, not by a Radix trigger, so Radix cannot send focus back. This remembers the element that had
 * focus as the dialog opened and returns it on close. Pass the result to `onCloseAutoFocus` of DialogContent.
 */
export function useReturnFocus(open: boolean) {
  const opener = React.useRef<HTMLElement | null>(null);
  const wasOpen = React.useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  return React.useCallback((e: Event) => {
    const el = opener.current;
    if (el && el.isConnected) {
      e.preventDefault();
      el.focus();
    }
  }, []);
}

/**
 * A confirmation step: names what will happen, offers Cancel first, and focus returns to the trigger on close (Radix).
 * `children` can add extra content (for example an acknowledgement checkbox) and `confirmDisabled` holds the button.
 */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, onConfirm, busy, destructive, confirmDisabled, children, testId = "confirm",
}: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: React.ReactNode; confirmLabel: string;
  onConfirm: () => void; busy?: boolean; destructive?: boolean; confirmDisabled?: boolean; children?: React.ReactNode; testId?: string;
}) {
  const onCloseAutoFocus = useReturnFocus(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={`${testId}-dialog`} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription asChild><div className="space-y-2">{description}</div></DialogDescription>
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={busy || confirmDisabled} data-testid={`${testId}-confirm`}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Usage as a table with bars. The bars are decoration (aria-hidden); the table carries every number as text, so it is the
 * text equivalent of the chart. Bars show exclusive bytes (solid) and shared bytes (lighter) on one scale.
 */
export function UsageTable({
  report, caption, nameHeading, renderAction, actionHeading, showSplit = true, testId,
}: {
  report: UsageReport; caption: string; nameHeading: string; renderAction?: (row: UsageRow) => React.ReactNode; actionHeading?: string; showSplit?: boolean; testId?: string;
}) {
  const scale = barScale(report.items);
  return (
    <Table aria-label={caption} data-testid={testId}>
      <caption className="sr-only">{caption}. Bars are shown for sighted users; every figure is also in the table.</caption>
      <TableHeader>
        <TableRow>
          <TableHead>{nameHeading}</TableHead>
          <TableHead className="text-right">{showSplit ? "Only here" : "Size"}</TableHead>
          {showSplit ? <TableHead className="text-right">Shared</TableHead> : null}
          <TableHead className="text-right">Files</TableHead>
          {renderAction ? <TableHead>{actionHeading ?? "Change"}</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {report.items.length === 0 ? (
          <TableRow><TableCell colSpan={5} className="text-muted-foreground">Nothing stored yet.</TableCell></TableRow>
        ) : null}
        {report.items.map((row) => {
          const w = barWidths(row, scale);
          return (
            <TableRow key={row.key} data-testid="usage-row" data-key={row.key}>
              <TableCell className="min-w-48">
                <div className="font-medium" data-testid="usage-name">{usageLabel(report.by, row)}</div>
                <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                  <div className="h-full bg-primary" style={{ width: w.exclusive }} />
                  <div className="h-full bg-primary/40" style={{ width: w.shared }} />
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums" data-testid="usage-exclusive">{formatBytes(row.exclusiveBytes)}</TableCell>
              {showSplit ? <TableCell className="text-right tabular-nums" data-testid="usage-shared">{formatBytes(row.sharedBytes)}</TableCell> : null}
              <TableCell className="text-right tabular-nums">{row.blobCount.toLocaleString("en-GB")}</TableCell>
              {renderAction ? <TableCell>{renderAction(row)}</TableCell> : null}
            </TableRow>
          );
        })}
      </TableBody>
      {report.items.length > 0 ? (
        <tfoot>
          <TableRow className="font-medium">
            <TableCell>Total stored (each file counted once)</TableCell>
            <TableCell className="text-right tabular-nums" colSpan={showSplit ? 2 : 1} data-testid="usage-total">{formatBytes(report.totalBytes)}</TableCell>
            <TableCell className="text-right tabular-nums">{report.blobCount.toLocaleString("en-GB")}</TableCell>
            {renderAction ? <TableCell /> : null}
          </TableRow>
        </tfoot>
      ) : null}
    </Table>
  );
}

export function UsageKey() {
  return (
    <p className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5"><span className="inline-block h-1.5 w-6 rounded-full bg-primary" aria-hidden="true" /> Only here: removing the group frees this</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-1.5 w-6 rounded-full bg-primary/40" aria-hidden="true" /> Shared: also used by another group</span>
    </p>
  );
}
