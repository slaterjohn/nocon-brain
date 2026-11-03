"use client";

import * as React from "react";
import { useApi } from "@/lib/api";
import { safeLink, type VersionAttribution } from "@/lib/zim";
import { formatDate } from "./format";

function Link({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  const safe = safeLink(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{children}<span className="sr-only"> (opens in a new browser tab)</span></a> : <>{children}</>;
}

/** Licence, revision and history link of a saved Wikipedia article, with the credits of its images. Shown only when the version has them. */
export function AttributionPanel({ versionId }: { versionId: string }) {
  const v = useApi<{ attribution?: VersionAttribution }>(`/api/archive/versions/${encodeURIComponent(versionId)}`);
  const a = v.data?.attribution;
  if (!a) return null;
  const images = a.images ?? [];
  return (
    <div className="mt-4 rounded-md border p-3 text-sm" data-testid="version-attribution">
      <h4 className="mb-1 font-semibold">Credit</h4>
      <p>
        Text licensed <Link href={a.licenseUrl}>{a.licenseName ?? "under the licence the source states"}</Link>.
        {a.creditText ? ` ${a.creditText}` : ""}
      </p>
      <dl className="mt-2 space-y-1">
        {a.sourceUrl ? <div><dt className="inline text-muted-foreground">Article: </dt><dd className="inline break-all"><Link href={a.sourceUrl}>{a.sourceUrl}</Link></dd></div> : null}
        {a.revisionId ? <div><dt className="inline text-muted-foreground">Revision: </dt><dd className="inline" data-testid="attribution-revision">{a.revisionId}</dd></div> : null}
        {a.historyUrl ? <div><dt className="inline text-muted-foreground">Authors: </dt><dd className="inline"><Link href={a.historyUrl}>see the article history</Link></dd></div> : null}
        {a.retrievedAt ? <div><dt className="inline text-muted-foreground">Copied on: </dt><dd className="inline">{formatDate(a.retrievedAt)}</dd></div> : null}
      </dl>
      {images.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer">Image credits ({images.length})</summary>
          <ul className="mt-2 space-y-1">
            {images.map((i, n) => (
              <li key={`${i.url}-${n}`} data-testid="image-credit">
                <Link href={i.sourcePageUrl}>{i.file ?? "Image"}</Link>
                {i.author ? `, by ${i.author.replace(/<[^>]*>/g, "")}` : ""}
                {i.licenseName ? <>, <Link href={i.licenseUrl}>{i.licenseName}</Link></> : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
