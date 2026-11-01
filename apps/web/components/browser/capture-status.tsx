"use client";

import * as React from "react";
import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { get } from "@/lib/api";
import { useEvents } from "@/components/layout/events";
import type { CaptureProgress } from "@/lib/types";

/**
 * The progress of one save. The visible line follows every event from the server's event stream; screen readers hear only the
 * changes of state, through the announcer in EventsProvider, so the stage names do not read out one after another.
 */
export function CaptureStatus({ downloadId, onOpenSaved, compact = false }: { downloadId: string; onOpenSaved?: () => void; compact?: boolean }) {
  const { captures } = useEvents();
  const c: CaptureProgress | undefined = captures[downloadId];
  const [poll, setPoll] = React.useState<CaptureProgress | undefined>();

  // A reload of the page or a dropped stream can miss events: ask the server once if nothing has arrived.
  React.useEffect(() => {
    if (c && c.state !== "queued") return;
    const t = setTimeout(() => {
      get<CaptureProgress>(`/api/archive/captures/${downloadId}`).then(setPoll).catch(() => undefined);
    }, 2500);
    return () => clearTimeout(t);
  }, [c, downloadId]);

  const p = c ?? poll;
  if (!p) return null;
  const done = p.state === "completed";
  const failed = p.state === "failed";
  const Icon = failed ? XCircle : done ? CheckCircle2 : p.held ? Clock : Loader2;
  return (
    <div
      data-testid="capture-status"
      data-state={p.state}
      data-outcome={p.outcome}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-secondary px-3 py-2 text-sm"
    >
      <Icon className={failed ? "size-4 text-destructive" : done ? "size-4 text-success" : p.held ? "size-4" : "size-4 animate-spin"} aria-hidden="true" />
      <span data-testid="capture-label">
        {failed ? `Could not be saved. ${p.failureMessage ?? ""}` : p.label}
      </span>
      {!done && !failed && !p.held ? (
        <Progress value={p.percent} label="Saving progress" className="h-2 w-40" />
      ) : null}
      {done && p.outcome === "created" && onOpenSaved && !compact ? (
        <Button size="sm" variant="outline" onClick={onOpenSaved} data-testid="open-saved">
          Open the saved copy
        </Button>
      ) : null}
    </div>
  );
}
