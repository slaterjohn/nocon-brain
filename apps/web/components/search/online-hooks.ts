"use client";

import * as React from "react";
import { EVENT_TYPES, type SearchEvent } from "@/lib/online-search";
import { HOVER_FREEZE_MS, OPEN, freeze, isScrollKey, type FreezeState, type Interaction } from "@/lib/search-freeze";

const POLL_MS = 600;
/** If the stream has produced nothing at all after this long, the page falls back to polling. */
const SILENT_MS = 8000;

export type Transport = "idle" | "sse" | "poll";

/**
 * Reads the events of an online run. Server-sent events when the browser has them (`addEventListener` per event type: the frames
 * are named, so `onmessage` would never fire), otherwise, or when the stream fails, polling `GET /api/search/{id}?after=`.
 * A dropped stream is reopened by the browser with `Last-Event-ID`; the reducer ignores anything it has already seen.
 */
export function useOnlineRun(opts: { searchId: string | null; active: boolean; afterSeq: number; epoch: number; onEvent: (e: SearchEvent) => void }) {
  const { searchId, active, epoch } = opts;
  const [transport, setTransport] = React.useState<Transport>("idle");
  const onEvent = React.useRef(opts.onEvent);
  onEvent.current = opts.onEvent;
  const seqRef = React.useRef(opts.afterSeq);
  const afterRef = React.useRef(opts.afterSeq);
  afterRef.current = opts.afterSeq;

  React.useEffect(() => {
    if (!searchId || !active) {
      setTransport("idle");
      return;
    }
    let stopped = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let silentTimer: ReturnType<typeof setTimeout> | null = null;
    seqRef.current = Math.max(seqRef.current, afterRef.current);

    const deliver = (e: SearchEvent) => {
      if (stopped) return;
      if (typeof e.seq === "number") seqRef.current = Math.max(seqRef.current, e.seq);
      onEvent.current(e);
      if (e.type === "done") stop();
    };

    function stop() {
      stopped = true;
      es?.close();
      es = null;
      if (pollTimer) clearTimeout(pollTimer);
      if (silentTimer) clearTimeout(silentTimer);
      setTransport("idle");
    }

    async function poll() {
      if (stopped) return;
      try {
        const res = await fetch(`/api/search/${encodeURIComponent(searchId!)}?after=${seqRef.current}`, { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } });
        if (res.status === 404 || res.status === 401) return stop();
        if (res.ok) {
          const j = (await res.json()) as { events?: SearchEvent[]; done?: boolean };
          for (const e of j.events ?? []) deliver(e);
          if (j.done && !stopped) return stop();
        }
      } catch {
        /* try again on the next tick */
      }
      if (!stopped) pollTimer = setTimeout(() => void poll(), POLL_MS);
    }

    function startPolling() {
      if (stopped) return;
      es?.close();
      es = null;
      if (silentTimer) clearTimeout(silentTimer);
      setTransport("poll");
      void poll();
    }

    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      // The first request names the point to resume from with `?after=`; a browser reconnect sends `Last-Event-ID` by itself.
      const source = new EventSource(`/api/search/${encodeURIComponent(searchId)}/events?after=${seqRef.current}`, { withCredentials: true });
      es = source;
      setTransport("sse");
      let heard = false;
      silentTimer = setTimeout(() => {
        if (!heard) startPolling();
      }, SILENT_MS);
      source.addEventListener("open", () => {
        heard = true;
      });
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (m) => {
          heard = true;
          try {
            deliver(JSON.parse((m as MessageEvent<string>).data) as SearchEvent);
          } catch {
            /* a frame that is not JSON is ignored */
          }
        });
      }
      source.addEventListener("error", () => {
        // CLOSED: the server refused (404, 204 after the end) and the browser will not retry. Poll to see whether it is finished.
        if (source.readyState === EventSource.CLOSED && !stopped) startPolling();
      });
    }
    return () => {
      stopped = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
      if (silentTimer) clearTimeout(silentTimer);
    };
  }, [searchId, active, epoch]);

  return transport;
}

/**
 * Freezes the list on the first interaction: a scroll, focus moving into the results, the pointer resting on a result for more than
 * 300 ms, or typing in the filters. Returns the state and a function that opens it again (a new search, or "Show new results").
 */
export function useFreeze(panel: React.RefObject<HTMLElement | null>, filters: React.RefObject<HTMLElement | null>, resetKey: string) {
  const [state, setState] = React.useState<FreezeState>(OPEN);
  const ref = React.useRef<FreezeState>(OPEN);
  const set = React.useCallback((kind: Interaction, hoverMs = 0) => {
    const next = freeze(ref.current, kind, hoverMs);
    if (next !== ref.current) {
      ref.current = next;
      setState(next);
    }
  }, []);
  const reset = React.useCallback(() => {
    ref.current = OPEN;
    setState(OPEN);
  }, []);

  React.useEffect(() => {
    reset();
  }, [resetKey, reset]);

  React.useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      // A scroll that does not move the page (Next resetting to the top) is not the Human.
      if (Math.abs(window.scrollY - lastY) >= 1) set("scroll");
      lastY = window.scrollY;
    };
    const onWheel = () => set("scroll");
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (isScrollKey(e.key) && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) set("keyboard_scroll");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchmove", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchmove", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [set]);

  React.useEffect(() => {
    const el = panel.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let over: Element | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      over = null;
    };
    const onFocus = () => set("focus");
    const onOver = (e: MouseEvent) => {
      const item = (e.target as Element | null)?.closest?.("[data-result-key]") ?? null;
      if (item === over) return;
      clear();
      if (!item) return;
      over = item;
      timer = setTimeout(() => set("hover", HOVER_FREEZE_MS + 1), HOVER_FREEZE_MS + 1);
    };
    el.addEventListener("focusin", onFocus);
    el.addEventListener("mouseover", onOver);
    el.addEventListener("mouseleave", clear);
    return () => {
      clear();
      el.removeEventListener("focusin", onFocus);
      el.removeEventListener("mouseover", onOver);
      el.removeEventListener("mouseleave", clear);
    };
  }, [panel, set]);

  React.useEffect(() => {
    const el = filters.current;
    if (!el) return;
    const onInput = () => set("filter_typing");
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && e.key.length === 1) set("filter_typing");
    };
    el.addEventListener("input", onInput);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKey);
    };
  }, [filters, set]);

  return { frozen: state.frozen, reason: state.reason, ref, reset, interact: set };
}

/** Keys of the results that are on screen right now, kept in a ref so the event handler can read them without a render. */
export function useVisibleKeys(container: React.RefObject<HTMLElement | null>, version: number) {
  const visible = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const root = container.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const key = (en.target as HTMLElement).dataset.resultKey;
        if (!key) continue;
        if (en.isIntersecting) visible.current.add(key);
        else visible.current.delete(key);
      }
    });
    root.querySelectorAll("[data-result-key]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [container, version]);
  return visible;
}
