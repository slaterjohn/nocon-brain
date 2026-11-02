"use client";

import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const OPERATORS: { op: string; what: string }[] = [
  { op: "site:example.org", what: "Only pages from that site." },
  { op: "type:pdf", what: "Only one type of page, such as pdf, html, text or markdown." },
  { op: "before:2026-01-01", what: "Published before a date. The saved date is used when no publication date is known." },
  { op: "after:2025-06-30", what: "Published after a date." },
  { op: '"exact phrase"', what: "Words together, in this order." },
  { op: "-word", what: "Leave out pages that contain the word." },
];

export function OperatorHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" data-testid="operator-help">
          <CircleHelp aria-hidden="true" /> Search tips
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)]">
        <h2 className="mb-2 text-sm font-semibold">Search tips</h2>
        <dl className="space-y-2 text-sm">
          {OPERATORS.map((o) => (
            <div key={o.op}>
              <dt><code className="rounded bg-muted px-1.5 py-0.5 text-xs">{o.op}</code></dt>
              <dd className="mt-0.5 text-muted-foreground">{o.what}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">Combine them: <code className="rounded bg-muted px-1 py-0.5">tides site:example.org -moon</code></p>
      </PopoverContent>
    </Popover>
  );
}
