"use client";

import * as React from "react";
import { Globe, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Wordmark } from "@/components/layout/app-shell";
import { EmptyState } from "@/components/layout/states";
import { BrowserChrome } from "./chrome";
import { tabUrl, useBrowser } from "./tabs";

function SearchHome({ onSearchNotReady, message }: { onSearchNotReady: () => void; message: string | null }) {
  const [q, setQ] = React.useState("");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16">
      <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">
        <Wordmark />
      </h1>
      <form
        role="search"
        className="flex w-full max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) onSearchNotReady();
        }}
      >
        <label htmlFor="home-search" className="sr-only">
          Search your archive and the web
        </label>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" aria-hidden="true" />
          <Input
            id="home-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            autoComplete="off"
            className="h-10 rounded-full pl-9"
          />
        </div>
        <Button type="submit" className="h-10 rounded-full px-5">
          Search
        </Button>
      </form>
      <p className="min-h-5 text-sm text-muted-foreground" role="status">
        {message}
      </p>
    </div>
  );
}

/** The Browser area: chrome plus the active tab's content. Phase 1 shows the search home or a placeholder. */
export function BrowserView() {
  const b = useBrowser();
  const addressRef = React.useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const url = tabUrl(b.active);

  React.useEffect(() => setMessage(null), [b.activeId]);

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col lg:min-h-[calc(100dvh-3.5rem)]">
      <BrowserChrome addressRef={addressRef} />
      <div id="browser-panel" role="region" aria-label="Page content" className="flex flex-1 flex-col" key={`${b.activeId}-${b.reloadCount}`}>
        {url ? (
          <div className="p-6">
            <h1 className="sr-only">Browser</h1>
            <EmptyState
              icon={Globe}
              title="Opening pages isn't available yet"
              description={`"${url}" can't be opened in this version. Saved pages open here once archiving is built.`}
            />
          </div>
        ) : (
          <SearchHome
            message={message}
            onSearchNotReady={() => setMessage("Search isn't connected yet. It arrives in a later release.")}
          />
        )}
      </div>
    </div>
  );
}
