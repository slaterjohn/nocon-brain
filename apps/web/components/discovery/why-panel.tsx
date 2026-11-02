"use client";

import * as React from "react";
import Link from "next/link";
import { errorMessage, get } from "@/lib/api";
import { KIND_LABEL, scoreTable, type Explanation, type Provenance } from "@/lib/discovery";
import { formatDate } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorState, LoadingSkeleton } from "@/components/layout/states";
import { Notice } from "@/components/storage/shared";

function ProvenanceItem({ p }: { p: Provenance }) {
  return (
    <li className="text-sm" data-testid="why-provenance-item" data-kind={p.kind}>
      <span className="font-medium">{KIND_LABEL[p.kind]}</span>
      {p.pageId ? (
        <>
          {" on "}
          <Link href={`/library/pages/${p.pageId}`} className="underline underline-offset-2">{p.pageTitle || p.pageUrl || "a saved page"}</Link>
        </>
      ) : null}
      {p.sourceName ? <> from the source {p.sourceId ? <Link href={`/library/sources/${p.sourceId}`} className="underline underline-offset-2">{p.sourceName}</Link> : p.sourceName}</> : null}
      {p.detail ? <> ({p.detail})</> : null}
      <span className="text-muted-foreground"> · {formatDate(p.at)}</span>
    </li>
  );
}

/**
 * "Why suggested": the plain sentences, the score as a table whose contributions add up to the score, and where the suggestion came from.
 * Nothing here is invented client-side: the figures come from GET /api/discovery/candidates/{id}.
 */
export function WhyPanel({ id, listedScore, panelId, headingId }: { id: string; listedScore: number; panelId: string; headingId: string }) {
  const [detail, setDetail] = React.useState<Explanation | null>(null);
  const [error, setError] = React.useState("");
  const load = React.useCallback(async () => {
    setError("");
    try {
      setDetail(await get<Explanation>(`/api/discovery/candidates/${id}/explain`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);
  React.useEffect(() => {
    void load();
  }, [load]);

  const table = detail ? scoreTable(detail.components, detail.score) : null;
  return (
    <section id={panelId} aria-labelledby={headingId} className="mt-3 space-y-4 rounded-lg border bg-muted/30 p-4" data-testid="why-panel">
      <h3 id={headingId} className="text-base font-semibold">Why this was suggested</h3>
      {error ? <ErrorState title="Couldn't load the reasons" message={error} onRetry={() => void load()} /> : null}
      {!detail && !error ? <LoadingSkeleton rows={3} label="Loading the reasons" /> : null}
      {detail && table ? (
        <>
          {!detail.scoreStored ? (
            <Notice title="Only the address is kept" testId="why-not-stored">
              This suggestion came from a search provider whose terms do not allow keeping its titles, snippets or scores. No title is shown. The score and the reasons below are worked out again from your current settings each time you open this panel.
            </Notice>
          ) : null}

          {Math.abs(listedScore - detail.score) >= 0.005 ? (
            <p className="text-sm text-muted-foreground" data-testid="why-differs">
              The list shows {Number(listedScore.toFixed(2))}, the score saved when this suggestion was last updated. This panel works the score out again now, which gives {Number(detail.score.toFixed(2))}. Recent activity fades with time.
            </p>
          ) : null}

          {detail.summary.length ? (
            <div>
              <h4 className="text-sm font-semibold">In words, largest reason first</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm" data-testid="why-sentences">
                {detail.summary.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          ) : (
            <p className="text-sm" data-testid="why-sentences">Nothing counts towards the score yet, so it is 0.</p>
          )}

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">How the score is worked out</h4>
            <p className="text-sm text-muted-foreground">
              Each factor is measured from 0 to 1, multiplied by its weight, and the results are added up. This is a plain weighted sum. A negative weight takes points away. You can change the weights in the settings.
            </p>
            <Table aria-label="Score components" data-testid="why-table">
              <caption className="sr-only">The factors behind the score. Each row is the measure times the weight. The total row is the score.</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Factor</TableHead>
                  <TableHead className="text-right">Measure (0 to 1)</TableHead>
                  <TableHead className="text-right">Weight</TableHead>
                  <TableHead className="text-right">Adds to the score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.rows.map((r) => (
                  <TableRow key={r.name} data-testid="why-row" data-name={r.name}>
                    <TableCell>
                      <div className="font-medium">{r.label}</div>
                      {r.explanation ? <div className="text-xs text-muted-foreground">{r.explanation}</div> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums" data-testid="why-raw">{r.raw}</TableCell>
                    <TableCell className="text-right tabular-nums" data-testid="why-weight">{r.weight}</TableCell>
                    <TableCell className="text-right tabular-nums" data-testid="why-contribution" data-value={r.value}>{r.contribution}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <tfoot>
                <TableRow className="font-medium">
                  <TableCell colSpan={3}>Score (the sum of the rows above)</TableCell>
                  <TableCell className="text-right tabular-nums" data-testid="why-total">{table.scoreText}</TableCell>
                </TableRow>
              </tfoot>
            </Table>
            <p className="text-sm" data-testid="why-sum" data-adds-up={table.addsUp ? "true" : "false"}>
              {table.addsUp
                ? <>In figures: {table.equation} = {table.scoreText}.</>
                : <>These figures add up to {table.sumText}, but the server gives the score as {table.scoreText}. The server's score is the one used.</>}
            </p>
          </div>

          <div>
            <h4 className="text-sm font-semibold">
              Where it came from
            </h4>
            {detail.provenance.length ? (
              <ul className="mt-1 list-disc space-y-1 pl-5" data-testid="why-provenance">
                {detail.provenance.map((p, i) => <ProvenanceItem key={`${p.kind}-${p.at}-${i}`} p={p} />)}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground" data-testid="why-provenance">No reasons are recorded.</p>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
