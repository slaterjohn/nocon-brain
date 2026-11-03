"use client";

import * as React from "react";
import { Library } from "lucide-react";
import { groupNote, languageLabel, SKIP_REASON_TEXT, type ZimBlock } from "@/lib/zim";
import { ResultItem } from "./result-item";

/**
 * What the package half of a search did: a note for every package that answered late, partly or with titles only, and the packages that
 * were left out. In the separate mode each package also gets its own list.
 */
export function ZimNotes({ block }: { block: ZimBlock }) {
  const notes = block.groups.map((g) => ({ key: g.zimId, title: g.title, text: groupNote(g) })).filter((n) => n.text);
  const skipped = block.skipped;
  if (!notes.length && !skipped.length) return null;
  return (
    <ul className="mb-3 space-y-1 text-sm text-muted-foreground" data-testid="zim-notes" aria-label="Package search notes">
      {notes.map((n) => <li key={n.key}><strong className="font-medium text-foreground">{n.title}:</strong> {n.text}</li>)}
      {skipped.map((s) => <li key={s.zimId}><strong className="font-medium text-foreground">{s.title}</strong> was {SKIP_REASON_TEXT[s.reason]}.</li>)}
    </ul>
  );
}

export function ZimGroups({ block }: { block: ZimBlock }) {
  const groups = block.groups.filter((g) => g.hits.length > 0);
  if (!groups.length) return null;
  return (
    <div className="mt-6 space-y-6" data-testid="zim-groups">
      <h2 className="text-lg font-semibold">From knowledge packages</h2>
      {groups.map((g) => (
        <section key={g.zimId} aria-labelledby={`zimg-${g.zimId}`} data-testid="zim-group" data-package={g.title}>
          <h3 id={`zimg-${g.zimId}`} className="flex flex-wrap items-center gap-2 text-base font-medium">
            <Library className="size-4 text-muted-foreground" aria-hidden="true" /> {g.title}
            <span className="text-xs font-normal text-muted-foreground">{languageLabel(g.language)}{g.estimatedMatches ? ` · about ${g.estimatedMatches.toLocaleString("en-GB")} matches` : ""}</span>
          </h3>
          <ol className="divide-y" aria-label={`Results from ${g.title}`}>
            {g.hits.map((h, i) => <li key={h.key}><ResultItem result={h} headingId={`zimhit-${g.zimId}-${i}`} /></li>)}
          </ol>
        </section>
      ))}
    </div>
  );
}
