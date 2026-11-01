"use client";

import * as React from "react";
import { Wifi, WifiOff, CircleHelp, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ConnectivityInfo, ConnectivityState } from "@/lib/types";
import { api } from "@/lib/api";

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
}

const Ctx = React.createContext<EventsValue>({ stream: "connecting", connectivity: "unknown" });
export const useEvents = () => React.useContext(Ctx);

function readState(data: string): ConnectivityState | null {
  try {
    const j = JSON.parse(data) as { state?: unknown; connectivity?: unknown; type?: unknown; data?: { state?: unknown } };
    const s = j.state ?? j.connectivity ?? j.data?.state;
    return s === "online" || s === "offline" || s === "unknown" ? s : null;
  } catch {
    return null;
  }
}

export function EventsProvider({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
  const [stream, setStream] = React.useState<StreamState>("connecting");
  const [connectivity, setConnectivity] = React.useState<ConnectivityState>("unknown");

  React.useEffect(() => {
    if (!enabled) return;
    let closed = false;
    api<ConnectivityInfo>("/api/system/connectivity", { noRedirect: true })
      .then((c) => {
        if (!closed) setConnectivity((cur) => (cur === "unknown" ? c.state : cur));
      })
      .catch(() => {});

    const es = new EventSource("/api/system/events");
    es.onopen = () => setStream("open");
    es.onerror = () => setStream(es.readyState === EventSource.CLOSED ? "lost" : "connecting");
    const onConnectivity = (e: MessageEvent<string>) => {
      const s = readState(e.data);
      if (s) setConnectivity(s);
    };
    es.addEventListener("connectivity", onConnectivity as EventListener);
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

  const value = React.useMemo(() => ({ stream, connectivity }), [stream, connectivity]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function ConnectivityIndicator() {
  const { stream, connectivity } = useEvents();
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
    hint = "No internet. Saved pages and local search still work.";
    variant = "warning";
    Icon = WifiOff;
  } else {
    label = "Connection unknown";
    hint = "NoConBrain hasn't checked the internet connection yet.";
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
