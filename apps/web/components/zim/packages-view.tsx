"use client";

import * as React from "react";
import Link from "next/link";
import { Library, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { LibraryNav } from "@/components/library/library-nav";
import { flavourLabel, formatCount, languageLabel } from "@/lib/zim";
import { formatBytes } from "@/lib/utils";
import type { ZimPackage } from "@/lib/zim";
import { usePackages } from "./hooks";
import { AddPackageDialog, LicenceLine, PackageIcon, PrioritySelect, RemovePackageDialog, StateBadge } from "./package-parts";

/** Knowledge packages in the Library: what is installed, its state, and adding and removing. */
export function PackagesView() {
  const list = usePackages();
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<ZimPackage | null>(null);
  const { mutate } = list;
  const refresh = React.useCallback(() => void mutate(), [mutate]);

  const addButton = (
    <Button onClick={() => setAdding(true)} data-testid="add-package">
      <Plus aria-hidden="true" /> Add a package
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <PageHeader title="Library" description="Pages you have saved. They open without internet." />
      <LibraryNav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Knowledge packages</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Packages are ZIM files, such as an offline Wikipedia. They open without internet and are searched with your saved pages. Packages are never removed automatically.
          </p>
        </div>
        {addButton}
      </div>
      {list.isLoading ? <LoadingSkeleton label="Loading packages" /> : null}
      {list.error ? <ErrorState title="Couldn't load packages" message={list.error.message} onRetry={() => void list.mutate()} /> : null}
      {list.data && list.packages.length === 0 ? (
        <EmptyState icon={Library} title="No packages yet" description="Add a ZIM file to read and search a whole encyclopaedia offline. The file must be on the machine running NoConBrain." action={addButton} />
      ) : null}
      {list.packages.length > 0 ? (
        <Table aria-label="Knowledge packages">
          <caption className="sr-only">Knowledge packages, with language, size, articles, state, priority and licence</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Package</TableHead>
              <TableHead>Language</TableHead>
              <TableHead>Flavour</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Articles</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Licence</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.packages.map((p) => (
              <TableRow key={p.id} data-testid="package-row" data-title={p.title}>
                <TableCell className="max-w-xs">
                  <div className="flex items-start gap-2">
                    <PackageIcon pkg={p} />
                    <div className="min-w-0">
                      <Link href={`/library/packages/${p.id}`} className="block truncate font-medium text-primary underline-offset-4 hover:underline" data-testid="package-link">{p.title}</Link>
                      <div className="text-xs text-muted-foreground">{p.storageMode === "copied" ? "Copied into storage" : "Read in place"}{p.enabledForSearch ? "" : " · Not searched"}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>{languageLabel(p.language)}</TableCell>
                <TableCell>{flavourLabel(p.flavour)}</TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">{formatBytes(p.sizeBytes)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(p.counts.articles)}</TableCell>
                <TableCell><StateBadge pkg={p} /></TableCell>
                <TableCell><PrioritySelect pkg={p} onChanged={refresh} /></TableCell>
                <TableCell className="max-w-56 text-xs"><LicenceLine pkg={p} /></TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(p)} data-testid="remove-package">
                      <Trash2 aria-hidden="true" /> Remove<span className="sr-only"> {p.title}</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <AddPackageDialog open={adding} onClose={() => setAdding(false)} onAdded={refresh} />
      <RemovePackageDialog pkg={removing} onClose={() => setRemoving(null)} onRemoved={refresh} />
    </div>
  );
}
