"use client";

import * as React from "react";

export interface SummaryItem {
  /** DOM id of the field the message is about. */
  id: string;
  message: string;
}

/**
 * Error summary for a form: a focusable box at the top that lists every problem as a link to its field.
 * Move focus to it (via the ref) after a failed submit, so screen reader users hear what went wrong.
 */
export const ErrorSummary = React.forwardRef<HTMLDivElement, { items: SummaryItem[]; title?: string }>(function ErrorSummary(
  { items, title = "There is a problem" },
  ref,
) {
  if (!items.length) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" aria-labelledby="error-summary-title" data-testid="error-summary" className="rounded-md border border-destructive/60 bg-destructive/10 p-4 outline-none">
      <h2 id="error-summary-title" className="text-sm font-semibold">{title}</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {items.map((i) => (
          <li key={i.id + i.message}>
            <a
              href={`#${i.id}`}
              className="underline underline-offset-2"
              onClick={(e) => {
                const el = document.getElementById(i.id);
                if (el) {
                  e.preventDefault();
                  el.focus();
                }
              }}
            >
              {i.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
});
