"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, PageHeader } from "@/components/layout/states";

/** The search results page. Local and online search arrive in Phase 4; until then it says so and keeps the words typed. */
export function SearchPlaceholder() {
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const [text, setText] = React.useState(q);
  React.useEffect(() => setText(q), [q]);
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <PageHeader title="Search" description="Search saved pages and, if you allow it, the web." />
      <form role="search" className="mb-6 flex max-w-xl gap-2" action="/search" method="get">
        <label htmlFor="search-q" className="sr-only">
          Search terms
        </label>
        <Input id="search-q" name="q" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search" autoComplete="off" />
        <Button type="submit">Search</Button>
      </form>
      <EmptyState
        icon={Search}
        title="Search isn't connected yet"
        description={q ? `"${q}" can't be searched in this version. Search arrives in a later release. Saved pages are in the Library, and you can type a web address in the browser.` : "Local and online search arrive in a later release."}
      />
    </div>
  );
}
