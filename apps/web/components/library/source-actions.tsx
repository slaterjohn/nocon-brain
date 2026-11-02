"use client";

import * as React from "react";
import Link from "next/link";
import { Pause, Play, PlayCircle, Power, PowerOff, Trash2 } from "lucide-react";
import { del, errorMessage, patch, post } from "@/lib/api";
import type { RunResult, Source } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

/** Run now, pause, resume, switch on or off. Returns busy state so buttons can disable themselves, and tells the screen to reload. */
export function useSourceActions(onChanged: () => void) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);

  const wrap = React.useCallback(
    async (s: Source, key: string, fn: () => Promise<void>, failTitle: string) => {
      setBusy(`${key}:${s.id}`);
      try {
        await fn();
        onChanged();
      } catch (e) {
        toast({ title: failTitle, description: errorMessage(e), variant: "error" });
      } finally {
        setBusy(null);
      }
    },
    [onChanged, toast],
  );

  return {
    busy,
    run: (s: Source) =>
      wrap(s, "run", async () => {
        const r = await post<RunResult>(`/api/sources/${s.id}/run`);
        const n = r.downloadIds?.length ?? 0;
        toast({
          title: `${s.name} is running`,
          description: r.warnings?.length ? r.warnings.join(" ") : `${n} ${n === 1 ? "download" : "downloads"} started. Follow progress on the Downloads screen.`,
          variant: "success",
        });
      }, "Couldn't run the source"),
    pause: (s: Source) => wrap(s, "pause", async () => { await post(`/api/sources/${s.id}/pause`); toast({ title: `${s.name} paused`, description: "Scheduled runs stop. You can still run it by hand." }); }, "Couldn't pause the source"),
    resume: (s: Source) => wrap(s, "resume", async () => { await post(`/api/sources/${s.id}/resume`); toast({ title: `${s.name} resumed` }); }, "Couldn't resume the source"),
    setEnabled: (s: Source, enabled: boolean) =>
      wrap(s, "enable", async () => { await patch(`/api/sources/${s.id}`, { enabled }); toast({ title: enabled ? `${s.name} switched on` : `${s.name} switched off`, description: enabled ? undefined : "It keeps its pages and their protection. It will not run until switched on." }); }, "Couldn't change the source"),
  };
}

export function RunButtons({ s, actions, size = "sm" }: { s: Source; actions: ReturnType<typeof useSourceActions>; size?: "sm" | "default" }) {
  const isBusy = (k: string) => actions.busy === `${k}:${s.id}`;
  return (
    <>
      <Button size={size} variant="outline" onClick={() => void actions.run(s)} disabled={!s.enabled || isBusy("run")} data-testid="run-now">
        <PlayCircle aria-hidden="true" /> Run now<span className="sr-only"> {s.name}</span>
      </Button>
      {s.paused ? (
        <Button size={size} variant="outline" onClick={() => void actions.resume(s)} disabled={isBusy("resume")} data-testid="resume-source">
          <Play aria-hidden="true" /> Resume<span className="sr-only"> {s.name}</span>
        </Button>
      ) : (
        <Button size={size} variant="outline" onClick={() => void actions.pause(s)} disabled={isBusy("pause") || !s.enabled} data-testid="pause-source">
          <Pause aria-hidden="true" /> Pause<span className="sr-only"> {s.name}</span>
        </Button>
      )}
    </>
  );
}

export function EnableButton({ s, actions, size = "sm" }: { s: Source; actions: ReturnType<typeof useSourceActions>; size?: "sm" | "default" }) {
  return (
    <Button size={size} variant="outline" onClick={() => void actions.setEnabled(s, !s.enabled)} disabled={actions.busy === `enable:${s.id}`} data-testid="toggle-enabled">
      {s.enabled ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
      {s.enabled ? "Switch off" : "Switch on"}<span className="sr-only"> {s.name}</span>
    </Button>
  );
}

/** Delete with the plain consequence: the pages stay, but stop being protected by this source. */
export function DeleteSourceDialog({ source, onClose, onDeleted, opener }: { source: Source | null; onClose: () => void; onDeleted: () => void; opener?: React.RefObject<HTMLElement | null> }) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setError(null), [source]);

  async function confirm() {
    if (!source) return;
    setBusy(true);
    try {
      await del(`/api/sources/${source.id}`);
      toast({ title: "Source deleted", description: `${source.name}. Its pages are still saved.` });
      onDeleted();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!source} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby="del-src-desc"
        onCloseAutoFocus={(e) => {
          if (opener?.current?.isConnected) {
            e.preventDefault();
            opener.current.focus();
          }
        }}
      >
        <div>
          <DialogTitle>Delete this source?</DialogTitle>
          <DialogDescription id="del-src-desc" className="mt-1">
            {source ? <strong className="break-words">{source.name}</strong> : null}
          </DialogDescription>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="delete-source-preview">
          <li>Every page this source saved stays in your Library.</li>
          <li>They lose the protection this source gave them ({source?.priority}). A page that no other source or collection keeps counts as lowest priority, and may be removed first when space runs short.</li>
          <li>Its schedule is deleted and any downloads still waiting or running for it are cancelled.</li>
        </ul>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy} data-testid="confirm-delete-source">
            <Trash2 aria-hidden="true" /> Delete source
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function NewSourceLink() {
  return (
    <Button asChild data-testid="new-source">
      <Link href="/library/sources/new">New source</Link>
    </Button>
  );
}
