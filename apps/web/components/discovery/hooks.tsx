"use client";

import * as React from "react";
import { Play } from "lucide-react";
import { errorMessage, post, useApi } from "@/lib/api";
import { shouldPoll, type PassReport, type RunnerStatus } from "@/lib/discovery";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/** Seconds between refreshes while work is going on, and while it is not. useApi only polls while the tab is visible. */
export const POLL_BUSY_MS = 2500;
export const POLL_IDLE_MS = 20_000;

/**
 * The runner status, refreshed often while a pass is running or discovery downloads are in flight and rarely otherwise.
 * `passRunning` is set by whoever started a pass, so the first refreshes do not wait for the idle interval.
 */
export function useRunner(passRunning = false) {
  const [busy, setBusy] = React.useState(false);
  const q = useApi<RunnerStatus>("/api/discovery/runner", { refreshInterval: busy || passRunning ? POLL_BUSY_MS : POLL_IDLE_MS });
  const wanted = shouldPoll(q.data, passRunning);
  React.useEffect(() => setBusy(wanted), [wanted]);
  return q;
}

/** "Run a pass now": one pass that obeys every limit. Reports what it did in words. */
export function RunPassButton({ disabled, onRunning, onDone, variant = "default" }: {
  disabled?: boolean;
  onRunning?: (running: boolean) => void;
  onDone?: (report: PassReport) => void;
  variant?: "default" | "outline";
}) {
  const { toast } = useToast();
  const [running, setRunning] = React.useState(false);
  async function run() {
    setRunning(true);
    onRunning?.(true);
    try {
      const report = await post<PassReport>("/api/discovery/run");
      const started = report.active.started + report.background.started;
      toast({
        title: started ? `Started ${started} ${started === 1 ? "download" : "downloads"}` : "Nothing was started",
        description: started ? "They are in the download list." : "See the runner panel for the reason.",
      });
      onDone?.(report);
    } catch (e) {
      toast({ title: "Couldn't run a pass", description: errorMessage(e), variant: "error" });
    } finally {
      setRunning(false);
      onRunning?.(false);
    }
  }
  return (
    <Button variant={variant} onClick={() => void run()} disabled={disabled || running} data-testid="run-pass">
      <Play aria-hidden="true" /> {running ? "Running a pass…" : "Run a pass now"}
    </Button>
  );
}
