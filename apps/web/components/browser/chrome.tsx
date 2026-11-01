"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, Plus, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tabTitle, tabUrl, useBrowser } from "./tabs";

/**
 * Browser chrome: tab strip, back/forward/reload and an address bar.
 * Shortcuts (Ctrl or Cmd): T new tab, W close tab, L focus the address bar; Alt+Left and Alt+Right for history.
 * Browsers reserve some of these (Ctrl+T, Ctrl+W) and do not pass them to a page, so each action also has a button.
 * The A-19 task reviews the final map against reserved keys.
 */
export function BrowserChrome({ addressRef }: { addressRef: React.RefObject<HTMLInputElement | null> }) {
  const b = useBrowser();
  const url = tabUrl(b.active);
  const [text, setText] = React.useState(url);

  // Keep the address bar in step with the active tab and its history position.
  React.useEffect(() => setText(url), [url, b.activeId]);

  const focusAddress = React.useCallback(() => {
    addressRef.current?.focus();
    addressRef.current?.select();
  }, [addressRef]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === "t") {
          e.preventDefault();
          b.newTab();
          // The address bar of the new tab takes focus once it has rendered.
          setTimeout(focusAddress, 0);
        } else if (k === "w") {
          e.preventDefault();
          b.closeTab(b.activeId);
        } else if (k === "l") {
          e.preventDefault();
          focusAddress();
        }
      } else if (e.altKey && !mod && !e.shiftKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          b.back();
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          b.forward();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [b, focusAddress]);

  const canBack = b.active.index > 0;
  const canForward = b.active.index < b.active.history.length - 1;

  return (
    <div className="border-b bg-chrome" data-testid="browser-chrome">
      <div className="flex items-end gap-1 px-2 pt-2">
        <ul aria-label="Open tabs" className="flex min-w-0 items-end gap-1 overflow-x-auto">
          {b.tabs.map((t) => {
            const selected = t.id === b.activeId;
            const title = tabTitle(t);
            return (
              <li
                key={t.id}
                data-testid="browser-tab"
                data-selected={selected}
                className={cn(
                  "flex h-9 max-w-52 min-w-28 items-center rounded-t-md border border-b-0",
                  selected ? "bg-background" : "bg-secondary hover:bg-accent",
                )}
              >
                <button
                  type="button"
                  id={`${t.id}-tab`}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => b.selectTab(t.id)}
                  className={cn("min-w-0 flex-1 truncate rounded-tl-md px-3 py-1.5 text-left text-sm", selected && "font-medium")}
                >
                  {title}
                  {selected ? <span className="sr-only"> (current tab)</span> : null}
                </button>
                <button
                  type="button"
                  onClick={() => b.closeTab(t.id)}
                  className="mr-1 inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">Close tab {title}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <Button variant="ghost" size="icon" className="mb-0.5 size-8 shrink-0" onClick={() => { b.newTab(); setTimeout(focusAddress, 0); }} aria-keyshortcuts="Control+T Meta+T">
          <Plus aria-hidden="true" />
          <span className="sr-only">New tab</span>
        </Button>
      </div>
      <div className="flex items-center gap-1 border-t bg-background px-2 py-2">
        <Button variant="ghost" size="icon" disabled={!canBack} onClick={b.back} aria-keyshortcuts="Alt+ArrowLeft">
          <ArrowLeft aria-hidden="true" />
          <span className="sr-only">Back</span>
        </Button>
        <Button variant="ghost" size="icon" disabled={!canForward} onClick={b.forward} aria-keyshortcuts="Alt+ArrowRight">
          <ArrowRight aria-hidden="true" />
          <span className="sr-only">Forward</span>
        </Button>
        <Button variant="ghost" size="icon" onClick={b.reload}>
          <RotateCw aria-hidden="true" />
          <span className="sr-only">Reload</span>
        </Button>
        <form
          role="search"
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) b.navigate(text);
          }}
        >
          <label htmlFor="address-bar" className="sr-only">
            Address or search terms
          </label>
          <Input
            id="address-bar"
            ref={addressRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Enter a web address or search terms"
            autoComplete="off"
            spellCheck={false}
            aria-keyshortcuts="Control+L Meta+L"
            className="rounded-full bg-chrome px-4"
          />
        </form>
      </div>
    </div>
  );
}
