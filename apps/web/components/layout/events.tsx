"use client";

import * as React from "react";
import { Wifi, WifiOff, CircleHelp, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { CaptureProgress, ConnectivityInfo, ConnectivityState, DownloadJob } from "@/lib/types";
import { api, errorMessage } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * Connectivity, fed from the SSE endpoint GET /api/system/events (docs/api.md section 13).
 * The event payloads are not specified in the contract. Assumed: an event named `connectivity` (or an unnamed
 * message with `type: "connectivity"`) whose JSON data carries `state: "online" | "offline" | "unknown"`.
 * Everything else on the stream (job progress, heartbeats) is ignored here.
 */

type StreamState = "connecting" | "open" | "lost";

interface EventsValue {
  stream: StreamState;
  connectivity: ConnectivityState;
  /** True while the "Work offline" switch is on (the server reports source "forced"). */
  forced: boolean;
  setForceOffline: (on: boolean) => Promise<void>;
  /** Latest progress of each capture seen on the stream, by download id (`capture` events, A-15). */
  captures: Record<string, CaptureProgress>;
  /** Tell the stream about a capture the page just started (the first event can arrive before the response). */
  trackCapture: (c: CaptureProgress) => void;
  /** Listen to `download.update` and `download.queue` events (and a `reconnected` signal). Returns the unsubscribe function. */
  subscribeDownloads: (fn: (e: DownloadEvent) => void) => () => void;
}

export type DownloadEvent =
  | { type: "download.update"; download: DownloadJob }
  | { type: "download.queue"; data: { counts?: Record<string, number> } }
  | { type: "reconnected" };

const Ctx = React.createContext<EventsValue>({
  stream: "connecting", connectivity: "unknown", forced: false, setForceOffline: async () => {}, captures: {}, trackCapture: () => {}, subscribeDownloads: () => () => {},
});
export const useEvents = () => React.useContext(Ctx);

function readState(data: string): { state: ConnectivityState; forced: boolean } | null {
  try {
    const j = JSON.parse(data) as { state?: unknown; connectivity?: unknown; source?: unknown; data?: { state?: unknown; source?: unknown } };
    const s = j.state ?? j.connectivity ?? j.data?.state;
    const source = j.source ?? j.data?.source;
    return s === "online" || s === "offline" || s === "unknown" ? { state: s, forced: source === "forced" } : null;
  } catch {
    return null;
  }
}

export function EventsProvider({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
  const [stream, setStream] = React.useState<StreamState>("connecting");
  const [connectivity, setConnectivity] = React.useState<ConnectivityState>("unknown");
  const [forced, setForced] = React.useState(false);
  const [captures, setCaptures] = React.useState<Record<string, CaptureProgress>>({});
  const [announcement, setAnnouncement] = React.useState("");
  const lastState = React.useRef<Record<string, string>>({});
  const dlListeners = React.useRef(new Set<(e: DownloadEvent) => void>());
  const subscribeDownloads = React.useCallback((fn: (e: DownloadEvent) => void) => {
    dlListeners.current.add(fn);
    return () => { dlListeners.current.delete(fn); };
  }, []);

  const trackCapture = React.useCallback((c: CaptureProgress) => {
    setCaptures((m) => (m[c.downloadId] ? m : { ...m, [c.downloadId]: c }));
  }, []);

  const setForceOffline = React.useCallback(async (on: boolean) => {
    const c = await api<ConnectivityInfo>("/api/system/connectivity", { method: "POST", body: { forceOffline: on } });
    setConnectivity(c.state);
    setForced(c.source === "forced");
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    let closed = false;
    api<ConnectivityInfo>("/api/system/connectivity", { noRedirect: true })
      .then((c) => {
        if (closed) return;
        setConnectivity(c.state);
        setForced(c.source === "forced");
      })
      .catch(() => {});

    const emit = (e: DownloadEvent) => dlListeners.current.forEach((fn) => fn(e));
    let opened = false;
    const es = new EventSource("/api/system/events");
    es.onopen = () => {
      setStream("open");
      if (opened) emit({ type: "reconnected" });
      opened = true;
    };
    es.onerror = () => setStream(es.readyState === EventSource.CLOSED ? "lost" : "connecting");
    const onConnectivity = (e: MessageEvent<string>) => {
      const s = readState(e.data);
      if (s) {
        setConnectivity(s.state);
        setForced(s.forced);
      }
    };
    es.addEventListener("connectivity", onConnectivity as EventListener);
    es.addEventListener("download.update", ((e: MessageEvent<string>) => {
      try {
        const j = JSON.parse(e.data) as { download?: DownloadJob };
        if (j.download) emit({ type: "download.update", download: j.download });
      } catch {
        /* ignore a malformed event */
      }
    }) as EventListener);
    es.addEventListener("download.queue", ((e: MessageEvent<string>) => {
      try {
        emit({ type: "download.queue", data: JSON.parse(e.data) as { counts?: Record<string, number> } });
      } catch {
        /* ignore */
      }
    }) as EventListener);
    // Capture progress: the visible line updates on every event; the screen reader announcement only on a change of state.
    es.addEventListener("capture", ((e: MessageEvent<string>) => {
      let c: CaptureProgress;
      try {
        c = JSON.parse(e.data) as CaptureProgress;
      } catch {
        return;
      }
      setCaptures((m) => ({ ...m, [c.downloadId]: c }));
      const key = c.held ? "held" : c.state === "completed" ? `completed:${c.outcome}` : c.state;
      if (lastState.current[c.downloadId] === key) return;
      lastState.current[c.downloadId] = key;
      let site = "the page";
      try {
        site = c.url ? new URL(c.url).hostname : site;
      } catch {
        /* keep the generic wording */
      }
      if (c.held) setAnnouncement(`Queued. ${site} will be saved when the connection returns.`);
      else if (c.state === "queued") setAnnouncement(`Saving ${site}.`);
      else if (c.state === "completed") setAnnouncement(c.outcome === "unchanged" ? `${site} is already saved and has not changed.` : `${site} is saved. It now opens offline.`);
      else if (c.state === "failed") setAnnouncement(`${site} could not be saved. ${c.failureMessage ?? ""}`.trim());
    }) as EventListener);
    es.onmessage = (e) => {
      try {
        if ((JSON.parse(e.data) as { type?: string }).type === "connectivity") onConnectivity(e);
      } catch {
        /* not JSON: ignore */
      }
    };
    return () => {
      closed = true;
      es.close();
    };
  }, [enabled]);

  const value = React.useMemo(
    () => ({ stream, connectivity, forced, setForceOffline, captures, trackCapture, subscribeDownloads }),
    [stream, connectivity, forced, setForceOffline, captures, trackCapture, subscribeDownloads],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="capture-announcer">
        {announcement}
      </div>
    </Ctx.Provider>
  );
}

export function ConnectivityIndicator() {
  const { stream, connectivity, forced } = useEvents();
  let label: string;
  let hint: string;
  let variant: "success" | "warning" | "secondary" = "secondary";
  let Icon = CircleHelp;
  if (stream !== "open" && connectivity === "unknown") {
    label = stream === "lost" ? "Updates stopped" : "Connecting";
    hint = stream === "lost" ? "Live updates from the server have stopped. Reload the page to retry." : "Waiting for the server.";
    Icon = RefreshCw;
  } else if (connectivity === "online") {
    label = "Online";
    hint = "The internet is reachable. Online search and downloads can run.";
    variant = "success";
    Icon = Wifi;
  } else if (connectivity === "offline") {
    label = "Offline";
    hint = forced ? "Work offline is on. Saved pages and local search still work." : "No internet. Saved pages and local search still work.";
    variant = "warning";
    Icon = WifiOff;
  } else {
    label = "Connection not checked";
    hint = "NoConBrain doesn't check the internet in the background. Online features are tried when you use them, and fall back to saved pages if they fail.";
  }
  return (
    <Badge variant={variant} data-testid="connectivity" data-state={connectivity} data-stream={stream} title={hint}>
      <Icon className="size-3" aria-hidden="true" />
      <span role="status">
        <span className="sr-only">Connection: </span>
        {label}
      </span>
    </Badge>
  );
}

/** The manual "Work offline" switch. Switching it off returns to the last observed state, which may be "not checked". */
export function WorkOfflineSwitch() {
  const { forced, setForceOffline } = useEvents();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function toggle(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setForceOffline(on);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="work-offline" className="text-xs text-muted-foreground">
        Work offline
      </Label>
      <Switch id="work-offline" checked={forced} disabled={busy} onCheckedChange={toggle} aria-describedby={error ? "work-offline-error" : undefined} />
      {error ? (
        <span id="work-offline-error" role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
