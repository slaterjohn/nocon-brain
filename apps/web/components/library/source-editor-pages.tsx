"use client";

import * as React from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import type { Source } from "@/lib/types";
import { Breadcrumb } from "@/components/common/breadcrumb";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { LibraryNav } from "./library-nav";
import { SourceForm } from "./source-form";

export function NewSourceView() {
  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <Breadcrumb items={[{ label: "Library", href: "/library" }, { label: "Sources", href: "/library/sources" }, { label: "New source" }]} />
      <PageHeader title="New source" description="Say what to save, how often, and how much it matters. You see an estimate before anything runs." />
      <LibraryNav />
      <p className="mb-4 text-sm" data-testid="package-source-hint">
        Making a source for a knowledge package you have added?{" "}
        <Link href="/library/sources/new/package" className="text-primary underline underline-offset-4" data-testid="package-source-link">Source for a knowledge package</Link>.
      </p>
      <SourceForm />
    </div>
  );
}

export function EditSourceView({ id }: { id: string }) {
  const src = useApi<Source>(`/api/sources/${id}`);
  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <Breadcrumb items={[{ label: "Library", href: "/library" }, { label: "Sources", href: "/library/sources" }, { label: src.data?.name ?? "Source", href: `/library/sources/${id}` }, { label: "Edit" }]} />
      <PageHeader title={src.data ? `Edit ${src.data.name}` : "Edit source"} description={src.data?.system ? "This is a built-in source. You can change its priority, retention and automatic removal, or switch it off." : "Saving changes to the limits or scope stores a new version of the settings. Pages already saved are kept."} />
      <LibraryNav />
      {src.isLoading ? <LoadingSkeleton variant="page" label="Loading the source" /> : null}
      {src.error ? <ErrorState title="Couldn't load this source" message={src.error.message} onRetry={() => void src.mutate()} /> : null}
      {src.data ? <SourceForm source={src.data} /> : null}
    </div>
  );
}
