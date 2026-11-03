"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { get } from "@/lib/api";
import type { FindResult } from "@/lib/types";
import type { Tab } from "./tabs";

/** The id prefix the listener gives its `<mark>` elements (packages/render/src/highlight.ts). */
const HIT = "ncb-hit-";

/**
 * Where the frame should point for hit `n` of `term` in the document the frame is showing now. The address is version-pinned
 * (`/v/{id}`), carries `?hl=` so the listener wraps the matches in `<mark>`, and ends in `#ncb-hit-N`. Moving between hits only
 * changes the fragment, which the browser handles as a same-document scroll without a request (decision D-6, spike A-18).
 */
export function hitUrl(frameUrl: string, versionId: string, term: string, n: number): string {
  const m = /^(https?:\/\/[^/]+)\/a\/([^/]+)\//.exec(frameUrl);
  if (!m) return frameUrl;
  return `${m[1]}/a/${m[2]}/v/${encodeURIComponent(versionId)}?hl=${encodeURIComponent(term)}#${HIT}${n}`;
}

export function plainUrl(frameUrl: string, versionId: string): string {
  const m = /^(https?:\/\/[^/]+)\/a\/([^/]+)\//.exec(frameUrl);
  return m ? `${m[1]}/a/${m[2]}/v/${encodeURIComponent(versionId)}` : frameUrl;
}

/** Points the frame somewhere. `location.replace` adds no joint-history entry; a cross-origin parent may call it. */
export function pointFrame(frame: HTMLIFrameElement, url: string): void {
  try {
    frame.contentWindow?.location.replace(url);
  } catch {
    frame.src = url;
  }
}

export function FindBar({ tab, getFrame, onClose }: { tab: Tab; getFrame: () => HTMLIFrameElement | null; onClose: () => void }) {
  const c = tab.content;
  const frameUrl = c.kind === "archive" ? c.frame.url : "";
  const versionId = c.kind === "archive" ? c.current.versionId : undefined;
  const reader = c.kind === "archive" && c.current.reader;
  const [q, setQ] = React.useState("");
  const [result, setResult] = React.useState<FindResult | null>(null);
  const [at, setAt] = React.useState(0); // 1-based index of the current hit, 0 when none
  const [error, setError] = React.useState<string | null>(null);
  const highlighted = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => inputRef.current?.focus(), []);

  const go = React.useCallback(
    (term: string, n: number) => {
      const f = getFrame();
      if (!f || !versionId) return;
      pointFrame(f, hitUrl(frameUrl, versionId, term, n));
      highlighted.current = true;
      setAt(n);
    },
    [frameUrl, versionId, getFrame],
  );
  // The count effect below must not restart when only the frame's address changes (it does, once the frame reports the highlighted
  // document it has just loaded): a restart would count again and jump back to the first hit, undoing a step made in between.
  const goRef = React.useRef(go);
  goRef.current = go;

  // Count after a short pause in typing; a new document (an in-frame click) starts a new search.
  React.useEffect(() => {
    setError(null);
    const term = q.trim();
    if (!term || !versionId || reader) {
      setResult(null);
      setAt(0);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      get<FindResult>(`/api/archive/versions/${encodeURIComponent(versionId)}/find?q=${encodeURIComponent(term)}`)
        .then((r) => {
          if (!live) return;
          setResult(r);
          if (r.count > 0) goRef.current(r.query, 1);
          else setAt(0);
        })
        .catch(() => live && setError("Couldn't search this page. Try again."));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, versionId, reader]);

  const step = (d: 1 | -1) => {
    if (!result || result.count === 0) return;
    go(result.query, ((at - 1 + d + result.count) % result.count) + 1);
  };

  const close = () => {
    const f = getFrame();
    // Closing clears the marks by showing the page again without them.
    if (highlighted.current && f && versionId) pointFrame(f, plainUrl(frameUrl, versionId));
    highlighted.current = false;
    onClose();
  };

  let status = "";
  if (reader) status = "Find in page isn't available in reader view. Use Ctrl+F or Cmd+F.";
  else if (error) status = error;
  else if (result && q.trim()) status = result.count === 0 ? "No matches" : `${at} of ${result.count}${result.truncated ? "+" : ""} matches`;

  return (
    <div role="search" aria-label="Find in page" className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2" data-testid="find-bar">
      <label htmlFor="find-input" className="sr-only">
        Find in this page
      </label>
      <Input
        id="find-input"
        ref={inputRef}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        placeholder="Find in this page"
        autoComplete="off"
        className="w-full sm:w-72"
        disabled={reader}
      />
      <Button size="sm" variant="outline" onClick={() => step(-1)} disabled={!result || result.count === 0}>
        <ChevronUp aria-hidden="true" /> Previous<span className="sr-only"> match</span>
      </Button>
      <Button size="sm" variant="outline" onClick={() => step(1)} disabled={!result || result.count === 0}>
        <ChevronDown aria-hidden="true" /> Next<span className="sr-only"> match</span>
      </Button>
      <span role="status" aria-live="polite" className="min-w-0 text-sm text-muted-foreground" data-testid="find-status">
        {status}
      </span>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={close}>
        <X aria-hidden="true" /> Close<span className="sr-only"> find bar</span>
      </Button>
    </div>
  );
}
