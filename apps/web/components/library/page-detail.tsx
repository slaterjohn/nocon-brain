"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Download, ExternalLink, FolderPlus, RefreshCw, ShieldQuestion, Trash2 } from "lucide-react";
import { errorMessage, post, useApi } from "@/lib/api";
import type { PageDetail as PageDetailData } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Breadcrumb } from "@/components/common/breadcrumb";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { LinkStateLegend } from "@/components/browser/shortcuts-dialog";
import { useBrowser } from "@/components/browser/tabs";
import { discoveredViaLabel, pageTypeLabel, priorityLabel } from "@/lib/library-copy";
import { formatBytes, formatDate } from "./format";
import { LibraryNav } from "./library-nav";
import { useCollections } from "./hooks";
import { AddToCollectionDialog } from "./add-to-collection";
import { DeleteDialog } from "./library-view";
import { CollectionIcon } from "./collection-icon";
import { AttributionPanel } from "./attribution";

const STATUS_WORDS: Record<string, string> = {
  ready: "Saved",
  partial: "Partly saved",
  capturing: "Being saved",
  failed: "Failed",
  evicting: "Being removed",
  evicted: "Removed to save space",
};
const PARTIAL_WORDS: Record<string, string> = {
  assets_missing: "Some images or files were not saved.",
  truncated: "The page was cut short because it was very large.",
  reader_only: "Only the reader text was saved.",
  size_cap: "Some files were left out because of the size limit.",
};
const AVAILABILITY_WORDS: Record<string, string> = {
  archived: "Saved",
  partial: "Partly saved",
  evicted: "Removed to save space",
  failed: "Could not be saved",
};

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-44 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

/** One saved page: its details, its versions (pick one to open it), what refers to it, and the link-state legend. */
export function PageDetailView({ id }: { id: string }) {
  const router = useRouter();
  const b = useBrowser();
  const { toast } = useToast();
  const detail = useApi<PageDetailData>(`/api/archive/pages/${encodeURIComponent(id)}`);
  const allCollections = useCollections();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const opener = React.useRef<HTMLElement | null>(null);

  const page = detail.data?.page;
  const versions = React.useMemo(() => [...(detail.data?.versions ?? [])].sort((a, c) => c.versionNo - a.versionNo), [detail.data]);
  const current = versions.find((v) => v.id === (selected ?? page?.latestVersionId)) ?? versions[0];

  async function recapture() {
    if (!page) return;
    setBusy(true);
    try {
      await post("/api/archive/capture", { url: page.url });
      toast({ title: "Saving a new version", description: "Follow it on the Downloads screen.", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't start the save", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (detail.isLoading) return <div className="mx-auto w-full max-w-5xl p-4 sm:p-6"><LoadingSkeleton variant="page" label="Loading the page" /></div>;
  if (detail.error || !page) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <LibraryNav />
        <ErrorState
          title={detail.error?.status === 404 ? "This page is no longer saved" : "Couldn't load this page"}
          message={detail.error?.status === 404 ? "It may have been deleted. Go back to the Library to find it again." : detail.error?.message}
          onRetry={detail.error?.status === 404 ? undefined : () => void detail.mutate()}
        />
      </div>
    );
  }

  const srcRefs = detail.data?.sources ?? [];
  const colRefs = detail.data?.collections ?? [];
  const imported = page.imported;

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <Breadcrumb items={[{ label: "Library", href: "/library" }, { label: "Pages", href: "/library" }, { label: page.title }]} />
      <PageHeader
        title={page.title}
        description={imported ? <span data-testid="page-origin">Imported document · {imported.filename}</span> : <span className="break-all" data-testid="page-origin">{page.url}</span>}
        actions={
          <>
            <Button onClick={() => b.openInBrowser(page.url)} data-testid="open-in-browser"><ExternalLink aria-hidden="true" /> Open in the browser</Button>
            <Button variant="outline" onClick={() => b.openInBrowser(page.url, { mode: "reader" })} data-testid="open-reader"><BookOpen aria-hidden="true" /> {page.type === "pdf" ? "Read the text" : "Reader view"}</Button>
            {imported && page.latestVersionId ? (
              <Button variant="outline" asChild data-testid="download-original">
                <a href={`/api/archive/versions/${encodeURIComponent(page.latestVersionId)}/original`} download={imported.filename}><Download aria-hidden="true" /> Download original</a>
              </Button>
            ) : null}
          </>
        }
      />
      <LibraryNav />

      <div className="mb-6 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)} data-testid="detail-add-collection"><FolderPlus aria-hidden="true" /> Add to collection</Button>
        <Button variant="outline" size="sm" asChild data-testid="detail-why-kept"><Link href={`/storage/pages/${page.id}`}><ShieldQuestion aria-hidden="true" /> Why is this kept?</Link></Button>
        {imported ? null : <Button variant="outline" size="sm" onClick={() => void recapture()} disabled={busy}><RefreshCw aria-hidden="true" /> Save a new version</Button>}
        <Button variant="ghost" size="sm" onClick={(e) => { opener.current = e.currentTarget; setDeleting(true); }}><Trash2 aria-hidden="true" /> Delete<span className="sr-only"> {page.title}</span></Button>
      </div>

      <section aria-labelledby="meta-h" className="mb-8">
        <h2 id="meta-h" className="mb-2 text-lg font-semibold">Details</h2>
        <dl className="divide-y rounded-lg border px-4" data-testid="page-meta">
          <Meta label="State"><Badge variant={page.availability === "archived" ? "success" : "warning"}>{AVAILABILITY_WORDS[page.availability] ?? page.availability}</Badge></Meta>
          {imported ? null : <Meta label="Site">{page.domain}</Meta>}
          <Meta label="Priority">{priorityLabel(page.effectivePriority)}</Meta>
          <Meta label="First saved">{formatDate(page.firstCapturedAt) || "Not known"}</Meta>
          <Meta label="Last saved">{formatDate(page.lastCapturedAt) || "Not known"}</Meta>
          <Meta label="Versions">{page.versionCount}</Meta>
          <Meta label="Size of the latest version">{formatBytes(page.totalBytes) || "Not known"}</Meta>
          <Meta label="Type and language"><span data-testid="page-type">{pageTypeLabel(page.type)}</span>{imported?.pageCount ? `, ${imported.pageCount} ${imported.pageCount === 1 ? "page" : "pages"}` : ""}{page.language ? `, ${page.language}` : ""}</Meta>
          <Meta label="Saved pages that link here">{page.inboundCount}</Meta>
          <Meta label="Bookmarks">{detail.data?.bookmarks ?? 0}</Meta>
          {!imported && page.canonicalUrl && page.canonicalUrl !== page.url ? <Meta label="Canonical address">{page.canonicalUrl}</Meta> : null}
        </dl>
      </section>

      <section aria-labelledby="versions-h" className="mb-8">
        <h2 id="versions-h" className="mb-1 text-lg font-semibold">Versions</h2>
        <p className="mb-3 text-sm text-muted-foreground">Every time the page is saved again and has changed, a new version is kept. Choose one to open it. Versions are listed, not compared.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Choose a version</legend>
            <ul className="divide-y rounded-lg border" data-testid="version-list">
              {versions.map((v) => (
                <li key={v.id}>
                  <label className="flex cursor-pointer items-start gap-3 p-3 has-[:checked]:bg-accent">
                    <input
                      type="radio"
                      name="version"
                      className="mt-1"
                      checked={current?.id === v.id}
                      onChange={() => setSelected(v.id)}
                      data-testid="version-option"
                    />
                    <span className="min-w-0 text-sm">
                      <span className="font-medium">Version {v.versionNo}{v.id === page.latestVersionId ? " (latest)" : ""}</span>
                      <span className="block text-muted-foreground">{formatDate(v.fetchedAt)} · {formatBytes(v.totalBytes)} · {STATUS_WORDS[v.status] ?? v.status}</span>
                    </span>
                  </label>
                </li>
              ))}
              {versions.length === 0 ? <li className="p-3 text-sm text-muted-foreground">No versions are stored for this page.</li> : null}
            </ul>
          </fieldset>
          {current ? (
            <div className="rounded-lg border p-4" aria-live="polite" data-testid="version-details">
              <h3 className="text-sm font-semibold">Version {current.versionNo}</h3>
              <dl className="mt-2 text-sm">
                <Meta label="State">{STATUS_WORDS[current.status] ?? current.status}</Meta>
                <Meta label="Saved on">{formatDate(current.fetchedAt)}</Meta>
                <Meta label="Size">{formatBytes(current.totalBytes)}</Meta>
                {current.partialReason ? <Meta label="What is missing">{PARTIAL_WORDS[current.partialReason] ?? current.partialReason}</Meta> : null}
              </dl>
              <AttributionPanel versionId={current.id} />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => b.openInBrowser(page.url, { versionId: current.id })} data-testid="open-version"><ExternalLink aria-hidden="true" /> Open this version</Button>
                <Button size="sm" variant="outline" onClick={() => b.openInBrowser(page.url, { versionId: current.id, mode: "reader" })}><BookOpen aria-hidden="true" /> Reader view<span className="sr-only"> of this version</span></Button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="refs-h" className="mb-8">
        <h2 id="refs-h" className="mb-2 text-lg font-semibold">Where this page belongs</h2>
        <div className="grid gap-4 md:grid-cols-2" data-testid="page-refs">
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">Sources</h3>
            {srcRefs.length ? (
              <ul className="space-y-1 text-sm">
                {srcRefs.map((s) => <li key={s.id} data-testid="page-source">
                    <Link className="text-primary underline-offset-4 hover:underline" href={`/library/sources/${s.id}`}>{s.name}</Link>
                    <span className="text-muted-foreground"> · {priorityLabel(s.priority)} · {discoveredViaLabel(s.discoveredVia)}</span>
                  </li>)}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No source keeps this page. It counts as lowest priority and may be removed first when space runs short.</p>}
          </div>
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">Collections</h3>
            {colRefs.length ? (
              <ul className="space-y-1 text-sm">
                {colRefs.map((c) => (
                  <li key={c.id} className="flex items-center gap-2" data-testid="page-collection">
                    <CollectionIcon name={allCollections.byId.get(c.id)?.icon ?? "folder"} />
                    <Link className="text-primary underline-offset-4 hover:underline" href={`/library/collections?c=${c.id}`}>{c.name}</Link>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">Not in any collection yet.</p>}
          </div>
        </div>
      </section>

      <section aria-labelledby="legend-h" className="mb-4">
        <h2 id="legend-h" className="mb-1 text-lg font-semibold">Links in saved pages</h2>
        <p className="mb-2 text-sm text-muted-foreground">When you read this page in the browser, each link is marked by what it leads to. When Work offline is on, a link that is not saved opens a notice instead of the live site.</p>
        <div className="rounded-lg border px-4 py-1"><LinkStateLegend className="divide-y" /></div>
      </section>

      <AddToCollectionDialog pageIds={[page.id]} open={addOpen} onClose={() => setAddOpen(false)} onDone={() => void detail.mutate()} />
      <DeleteDialog page={deleting ? page : null} opener={opener} onClose={() => setDeleting(false)} onDeleted={() => router.push("/library")} />
    </div>
  );
}
