"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { errorMessage, fieldErrors, post } from "@/lib/api";
import type { Priority, Source } from "@/lib/types";
import { PRIORITIES } from "@/lib/library-copy";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Breadcrumb } from "@/components/common/breadcrumb";
import { ErrorSummary, type SummaryItem } from "@/components/common/error-summary";
import { Field } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { LibraryNav } from "@/components/library/library-nav";
import { Library } from "lucide-react";
import { usePackages } from "./hooks";

const fid = (k: string) => `pkgsrc-${k}`;

/** A source bound to a package that has none. Packages added with the default settings already have one. */
export function NewPackageSourceView() {
  const router = useRouter();
  const list = usePackages();
  const free = list.packages.filter((p) => !p.sourceId);
  const [zimId, setZimId] = React.useState("");
  const [name, setName] = React.useState("");
  const [priority, setPriority] = React.useState<Priority | "">("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const [tick, setTick] = React.useState(0);
  const chosen = zimId || free[0]?.id || "";

  React.useEffect(() => {
    if (tick) summaryRef.current?.focus();
  }, [tick]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) {
      setErrors({ zimId: "Choose a package." });
      setTick((t) => t + 1);
      return;
    }
    setBusy(true);
    try {
      const s = await post<Source>("/api/sources", { type: "knowledge_package", zimId: chosen, ...(name.trim() ? { name: name.trim() } : {}), ...(priority ? { priority } : {}) });
      router.push(`/library/sources/${s.id}`);
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(Object.keys(fe).length ? fe : { zimId: errorMessage(err) });
      setTick((t) => t + 1);
    } finally {
      setBusy(false);
    }
  }

  const summary: SummaryItem[] = Object.entries(errors).map(([k, message]) => ({ id: fid(k), message }));
  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <Breadcrumb items={[{ label: "Library", href: "/library" }, { label: "Sources", href: "/library/sources" }, { label: "New source", href: "/library/sources/new" }, { label: "Knowledge package" }]} />
      <PageHeader title="Source for a knowledge package" description="A source lets a package sit in the Library with its priority, next to your saved sites. It downloads nothing: the package is already on this server." />
      <LibraryNav />
      {list.isLoading ? <LoadingSkeleton label="Loading packages" rows={2} /> : null}
      {list.error ? <ErrorState title="Couldn't load packages" message={list.error.message} onRetry={() => void list.mutate()} /> : null}
      {list.data && free.length === 0 ? (
        <EmptyState icon={Library} title={list.packages.length ? "Every package already has a source" : "No packages yet"} description={list.packages.length ? "Packages added with the default settings get a source when they are added." : "Add a package first, then make its source."} action={<Button asChild variant="outline"><Link href="/library/packages">Open the packages</Link></Button>} />
      ) : null}
      {free.length > 0 ? (
        <form onSubmit={(e) => void submit(e)} noValidate className="max-w-xl space-y-4" data-testid="package-source-form">
          <ErrorSummary ref={summaryRef} items={summary} />
          <Field id={fid("zimId")} label="Package" error={errors.zimId}>
            {(p) => <Select {...p} value={chosen} onChange={(e) => setZimId(e.target.value)} data-testid="package-source-package">{free.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</Select>}
          </Field>
          <Field id={fid("name")} label="Name" optional hint="Leave empty to use the package title." error={errors.name}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />}
          </Field>
          <Field id={fid("priority")} label="Priority" optional hint="Leave empty to keep the package's own priority." error={errors.priority}>
            {(p) => (
              <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as Priority | "")}>
                <option value="">Keep the package&apos;s priority</option>
                {PRIORITIES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </Select>
            )}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy} data-testid="package-source-create">{busy ? "Creating…" : "Create source"}</Button>
            <Button asChild variant="outline"><Link href="/library/sources/new">Back</Link></Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// ---- The body of a knowledge-package source's page ----

import { useApi as useApiHook } from "@/lib/api";
import { stateOf, zimUrl } from "@/lib/zim";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useBrowser } from "@/components/browser/tabs";

interface PackagePages { items: { kind: "zim"; zimId: string; path: string; title: string }[]; total?: number; nextCursor?: string }

/** What a source bound to a package shows instead of runs and saved pages: the package, and its articles by title. */
export function PackageSourcePanel({ source }: { source: Source }) {
  const b = useBrowser();
  const [limit, setLimit] = React.useState(25);
  const kp = source.knowledgePackage;
  const pages = useApiHook<PackagePages>(`/api/sources/${source.id}/pages?limit=${limit}`);
  const state = kp ? stateOf({ state: kp.state as never }) : null;
  return (
    <>
      <section aria-labelledby="kp-h" className="mb-8">
        <h2 id="kp-h" className="mb-2 text-lg font-semibold">Knowledge package</h2>
        {kp ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4" data-testid="source-package">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{kp.title}</p>
              <p className="text-sm text-muted-foreground">{formatBytes(kp.sizeBytes)}. Nothing is downloaded or run for this source, and the package is never removed automatically.</p>
            </div>
            {state ? <Badge variant={state.variant}>{state.label}</Badge> : null}
            <Button asChild variant="outline" size="sm"><Link href={`/library/packages/${kp.id}`}>Open the package</Link></Button>
          </div>
        ) : <p className="text-sm text-muted-foreground">The package for this source is no longer available.</p>}
      </section>
      <section aria-labelledby="kp-pages-h">
        <h2 id="kp-pages-h" className="mb-2 text-lg font-semibold">Articles in this package</h2>
        {pages.isLoading ? <LoadingSkeleton rows={3} label="Loading articles" /> : null}
        {pages.error ? <ErrorState title="Couldn't list articles" message={pages.error.message} onRetry={() => void pages.mutate()} /> : null}
        {pages.data && pages.data.items.length === 0 ? <p className="text-sm text-muted-foreground">No articles are listed.</p> : null}
        {pages.data && pages.data.items.length > 0 ? (
          <>
            <ul className="divide-y rounded-lg border" aria-label="Articles" data-testid="source-articles">
              {pages.data.items.map((e) => (
                <li key={e.path} className="p-2.5">
                  <button type="button" className="max-w-full truncate text-left text-primary underline-offset-4 hover:underline" onClick={() => b.openInBrowser(zimUrl(e.zimId, e.path))}>{e.title || e.path}</button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-muted-foreground" role="status">Showing {pages.data.items.length.toLocaleString("en-GB")} of {(pages.data.total ?? pages.data.items.length).toLocaleString("en-GB")}.</p>
            {pages.data.nextCursor ? <div className="mt-2"><Button variant="outline" onClick={() => setLimit((n) => n + 25)}>Show more</Button></div> : null}
          </>
        ) : null}
      </section>
    </>
  );
}
