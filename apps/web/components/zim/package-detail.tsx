"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, ExternalLink, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { errorMessage, get, patch, post, useApi } from "@/lib/api";
import type { Source } from "@/lib/types";
import {
  checkText, flavourLabel, formatCount, languageLabel, stateOf, zimUrl,
  type RemovalPlan, type VerifyResult, type ZimEntries, type ZimEntry, type ZimPackage, type ZimReferences,
} from "@/lib/zim";
import { formatBytes, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { Breadcrumb } from "@/components/common/breadcrumb";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { LibraryNav } from "@/components/library/library-nav";
import { useBrowser } from "@/components/browser/tabs";
import { Notice } from "@/components/storage/shared";
import { LicenceLine, PackageIcon, PrioritySelect, RemovePackageDialog, StateBadge } from "./package-parts";

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-44 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

const PAGE = 25;

/** Browse the package's articles by title, with a "Show more" that follows the cursor, and a title finder. */
function Entries({ pkg }: { pkg: ZimPackage }) {
  const b = useBrowser();
  const [items, setItems] = React.useState<ZimEntry[]>([]);
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [total, setTotal] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [term, setTerm] = React.useState("");
  const [found, setFound] = React.useState<ZimEntry[] | null>(null);
  const usable = pkg.state === "ready" || pkg.state === "degraded";

  const load = React.useCallback(
    async (after?: string) => {
      setLoading(true);
      setError(null);
      try {
        const r = await get<ZimEntries>(`/api/zim/packages/${encodeURIComponent(pkg.id)}/entries?limit=${PAGE}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
        setItems((cur) => (after ? [...cur, ...r.items] : r.items));
        setCursor(r.nextCursor);
        setTotal(r.total);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [pkg.id],
  );

  React.useEffect(() => {
    if (usable) void load();
    else setLoading(false);
  }, [usable, load]);

  React.useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  React.useEffect(() => {
    if (!term || !usable) {
      setFound(null);
      return;
    }
    let live = true;
    get<{ items: ZimEntry[] }>(`/api/zim/packages/${encodeURIComponent(pkg.id)}/suggest?q=${encodeURIComponent(term)}&limit=20`)
      .then((r) => live && setFound(r.items))
      .catch(() => live && setFound([]));
    return () => {
      live = false;
    };
  }, [term, usable, pkg.id]);

  const shown = found ?? items;
  return (
    <section aria-labelledby="entries-h" className="mb-8">
      <h2 id="entries-h" className="mb-1 text-lg font-semibold">Articles</h2>
      <p className="mb-3 text-sm text-muted-foreground">Browse by title, or type the start of a title. Choose an article to read it in the browser.</p>
      {!usable ? <Notice tone="warning">This package cannot be read right now ({stateOf(pkg).label.toLowerCase()}). Articles are listed again when it is ready.</Notice> : null}
      {usable ? (
        <>
          <div className="mb-3 max-w-sm">
            <Label htmlFor="entry-q" className="mb-1 block text-sm">Find an article by title</Label>
            <Input id="entry-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" data-testid="entry-find" />
          </div>
          {error ? <ErrorState title="Couldn't list articles" message={error} onRetry={() => void load(cursor)} /> : null}
          {loading && shown.length === 0 ? <LoadingSkeleton rows={4} label="Loading articles" /> : null}
          {!loading && !error && shown.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="entries-empty">{found ? "No title starts with that." : "This package lists no articles."}</p> : null}
          {shown.length > 0 ? (
            <ul className="divide-y rounded-lg border" aria-label="Articles" data-testid="entry-list">
              {shown.map((e) => (
                <li key={e.path} className="flex items-center gap-3 p-2.5" data-testid="entry-row">
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-primary underline-offset-4 hover:underline" onClick={() => b.openInBrowser(zimUrl(pkg.id, e.path))}>
                    {e.title || e.path}
                  </button>
                  <span className="shrink-0 truncate text-xs text-muted-foreground">{e.path}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {!found && shown.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground" role="status" data-testid="entries-count">Showing {items.length.toLocaleString("en-GB")} of {formatCount(total ?? pkg.counts.articles)}.</p>
              {cursor ? <Button variant="outline" onClick={() => void load(cursor)} disabled={loading} data-testid="entries-more">{loading ? "Loading…" : "Show more"}</Button> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function References({ pkg }: { pkg: ZimPackage }) {
  const refs = useApi<RemovalPlan>(`/api/zim/packages/${encodeURIComponent(pkg.id)}/references`);
  const r: ZimReferences | undefined = refs.data?.references;
  return (
    <section aria-labelledby="refs-h" className="mb-8">
      <h2 id="refs-h" className="mb-1 text-lg font-semibold">What refers to this package</h2>
      <p className="mb-3 text-sm text-muted-foreground">Removing the package changes these. You are asked first.</p>
      {refs.isLoading ? <LoadingSkeleton rows={2} label="Loading references" /> : null}
      {refs.error ? <ErrorState title="Couldn't load references" message={refs.error.message} onRetry={() => void refs.mutate()} /> : null}
      {r ? (
        <div className="grid gap-4 md:grid-cols-2" data-testid="package-refs">
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">Bookmarks ({r.bookmarks.count})</h3>
            {r.bookmarks.items.length ? <ul className="space-y-1 text-sm">{r.bookmarks.items.map((x) => <li key={x.id} className="truncate">{x.title}</li>)}</ul> : <p className="text-sm text-muted-foreground">None.</p>}
            {r.bookmarks.count ? <p className="mt-2 text-sm"><Link href="/bookmarks" className="text-primary underline underline-offset-4">All bookmarks</Link></p> : null}
          </div>
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">Collections ({r.collections.count})</h3>
            {r.collections.items.length ? <ul className="space-y-1 text-sm">{r.collections.items.map((x) => <li key={x.collectionId}>{x.name} <span className="text-muted-foreground">· {x.entries} {x.entries === 1 ? "article" : "articles"}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">None.</p>}
          </div>
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">Sources ({r.sources.count})</h3>
            {r.sources.items.length ? <ul className="space-y-1 text-sm">{r.sources.items.map((x) => <li key={x.id}><Link href={`/library/sources/${x.id}`} className="text-primary underline-offset-4 hover:underline">{x.name}</Link></li>)}</ul> : <p className="text-sm text-muted-foreground">None.</p>}
          </div>
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">History</h3>
            <p className="text-sm">{r.history.count.toLocaleString("en-GB")} {r.history.count === 1 ? "visit" : "visits"} recorded.</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** One package: its details, a check, its articles, and what refers to it. */
export function PackageDetailView({ id }: { id: string }) {
  const router = useRouter();
  const b = useBrowser();
  const { toast } = useToast();
  const detail = useApi<ZimPackage>(`/api/zim/packages/${encodeURIComponent(id)}`, { refreshInterval: 5000 });
  const [removing, setRemoving] = React.useState<ZimPackage | null>(null);
  const [check, setCheck] = React.useState<{ deep: boolean; result: VerifyResult } | null>(null);
  const [checking, setChecking] = React.useState<"quick" | "deep" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const pkg = detail.data;

  async function verify(deep: boolean) {
    setChecking(deep ? "deep" : "quick");
    try {
      const result = await post<VerifyResult>(`/api/zim/packages/${encodeURIComponent(id)}/verify`, { deep });
      setCheck({ deep, result });
      void detail.mutate();
    } catch (e) {
      toast({ title: "Couldn't check the package", description: errorMessage(e), variant: "error" });
    } finally {
      setChecking(null);
    }
  }

  async function setSearch(on: boolean) {
    setBusy(true);
    try {
      detail.setData(pkg ? { ...pkg, enabledForSearch: on } : pkg);
      await patch(`/api/zim/packages/${encodeURIComponent(id)}`, { enabledForSearch: on });
      toast({ title: on ? "Package is searched" : "Package is not searched", description: pkg?.title });
    } catch (e) {
      toast({ title: "Couldn't change the setting", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
      void detail.mutate();
    }
  }

  async function createSource() {
    if (!pkg) return;
    setBusy(true);
    try {
      const s = await post<Source>("/api/sources", { type: "knowledge_package", zimId: pkg.id });
      toast({ title: "Source created", description: s.name, variant: "success" });
      void detail.mutate();
    } catch (e) {
      toast({ title: "Couldn't create the source", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (detail.isLoading) return <div className="mx-auto w-full max-w-5xl p-4 sm:p-6"><LoadingSkeleton variant="page" label="Loading the package" /></div>;
  if (detail.error || !pkg) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <LibraryNav />
        <ErrorState
          title={detail.error?.status === 404 ? "This package no longer exists" : "Couldn't load this package"}
          message={detail.error?.status === 404 ? "It may have been removed. Go back to the packages to find it again." : detail.error?.message}
          onRetry={detail.error?.status === 404 ? undefined : () => void detail.mutate()}
        />
      </div>
    );
  }
  const usable = pkg.state === "ready" || pkg.state === "degraded";
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <Breadcrumb items={[{ label: "Library", href: "/library" }, { label: "Packages", href: "/library/packages" }, { label: pkg.title }]} />
      <PageHeader
        title={pkg.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge pkg={pkg} />
            <span>{languageLabel(pkg.language)}</span>
            <span>{formatBytes(pkg.sizeBytes)}</span>
          </span>
        }
        actions={
          <>
            {usable && pkg.mainPath ? (
              <Button onClick={() => b.openInBrowser(zimUrl(pkg.id, pkg.mainPath!))} data-testid="open-main"><ExternalLink aria-hidden="true" /> Open the main page</Button>
            ) : null}
            <Button variant="outline" onClick={() => void verify(false)} disabled={checking !== null} data-testid="verify-package"><ShieldCheck aria-hidden="true" /> {checking === "quick" ? "Checking…" : "Check package"}</Button>
            <Button variant="ghost" onClick={() => setRemoving(pkg)} data-testid="remove-package"><Trash2 aria-hidden="true" /> Remove<span className="sr-only"> {pkg.title}</span></Button>
          </>
        }
      />
      <LibraryNav />

      <div role="status" aria-live="polite" data-testid="verify-result" className="mb-6">
        {check ? (
          <div className="rounded-lg border p-4">
            <h2 className="text-sm font-semibold">{check.result.ok ? "The package passed the check" : "The package failed the check"}{check.deep ? " (deep)" : ""}</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {check.result.checks.map((c) => { const t = checkText(c); return <li key={c} className={t.ok ? undefined : "font-medium"}>{t.text}</li>; })}
            </ul>
            {!check.deep && check.result.ok ? (
              <Button className="mt-3" size="sm" variant="outline" onClick={() => void verify(true)} disabled={checking !== null}>{checking === "deep" ? "Checking…" : "Run a deep check"}<span className="sr-only"> (also reads the embedded checksum; slow for a large file)</span></Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <section aria-labelledby="meta-h" className="mb-8">
        <h2 id="meta-h" className="mb-2 text-lg font-semibold">Details</h2>
        <div className="flex flex-col gap-4 sm:flex-row">
          <PackageIcon pkg={pkg} className="size-12" />
          <dl className="min-w-0 flex-1 divide-y rounded-lg border px-4" data-testid="package-meta">
            {pkg.description ? <Meta label="Description">{pkg.description}</Meta> : null}
            <Meta label="State"><StateBadge pkg={pkg} /><span className="mt-1 block text-xs text-muted-foreground">{stateOf(pkg).help}</span></Meta>
            <Meta label="Language">{languageLabel(pkg.language)}</Meta>
            <Meta label="Flavour">{flavourLabel(pkg.flavour)}</Meta>
            <Meta label="Size">{formatBytes(pkg.sizeBytes)}</Meta>
            <Meta label="Contents"><span data-testid="package-counts">{formatCount(pkg.counts.articles)} articles, {formatCount(pkg.counts.media)} media files, {formatCount(pkg.counts.entries)} entries</span></Meta>
            <Meta label="Kept">{pkg.storageMode === "copied" ? "Copied into NoConBrain's storage. Removing the package deletes the copy." : "Read in place. Removing the package leaves the file on disk."}</Meta>
            <Meta label="File">{pkg.path}</Meta>
            <Meta label="Priority"><PrioritySelect pkg={pkg} onChanged={() => void detail.mutate()} /><span className="mt-1 block text-xs text-muted-foreground">Packages are never removed automatically, whatever the priority.</span></Meta>
            <Meta label="Search">
              <span className="flex items-center gap-2">
                <Switch id="pkg-search" checked={pkg.enabledForSearch} disabled={busy} onCheckedChange={(v) => void setSearch(v)} data-testid="package-search-switch" />
                <Label htmlFor="pkg-search" className="font-normal">Search this package</Label>
              </span>
            </Meta>
            <Meta label="Licence"><LicenceLine pkg={pkg} /></Meta>
            {pkg.license.url ? <Meta label="Licence address"><a href={pkg.license.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{pkg.license.url}<span className="sr-only"> (opens in a new browser tab)</span></a></Meta> : null}
            {pkg.creator || pkg.publisher ? <Meta label="Made by">{[pkg.creator, pkg.publisher].filter(Boolean).join(", ")}</Meta> : null}
            {pkg.sourceUrl ? <Meta label="Original source">{pkg.sourceUrl}</Meta> : null}
            {pkg.date ? <Meta label="Date of the file">{pkg.date}</Meta> : null}
            <Meta label="Indexes">{pkg.hasFulltextIndex ? "Full-text search" : "Titles only (no full-text index)"}</Meta>
            <Meta label="Checksum">{pkg.checksum.state === "done" ? <code className="text-xs break-all">{pkg.checksum.sha256}</code> : pkg.checksum.state === "pending" ? "Being worked out" : "Could not be worked out"}</Meta>
            <Meta label="Added">{formatDate(pkg.importedAt)}</Meta>
            <Meta label="Last checked">{pkg.lastVerifiedAt ? formatDate(pkg.lastVerifiedAt) : "Not checked yet"}</Meta>
            <Meta label="Source">
              {pkg.sourceId ? (
                <Link href={`/library/sources/${pkg.sourceId}`} className="text-primary underline-offset-4 hover:underline" data-testid="package-source-link">Open its source</Link>
              ) : (
                <span className="flex flex-wrap items-center gap-2">No source yet. <Button size="sm" variant="outline" onClick={() => void createSource()} disabled={busy} data-testid="create-source"><Plus aria-hidden="true" /> Create a source</Button></span>
              )}
            </Meta>
          </dl>
        </div>
      </section>

      <Entries pkg={pkg} />
      <References pkg={pkg} />
      <p className="text-sm text-muted-foreground"><BookOpen className="mr-1 inline size-4" aria-hidden="true" />Wikipedia packages also open when you type a Wikipedia address in the browser, even offline.</p>
      <RemovePackageDialog pkg={removing} onClose={() => setRemoving(null)} onRemoved={() => router.push("/library/packages")} />
    </div>
  );
}
