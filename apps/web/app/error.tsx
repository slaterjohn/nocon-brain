"use client";

import { ErrorState } from "@/components/layout/states";
import { PAGE_ERROR } from "@/lib/errors";

// The thrown error's own text is never shown: it may be technical, and in production Next.js replaces it with a digest anyway.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="mx-auto max-w-xl p-6">
      <h1 className="sr-only">{PAGE_ERROR.title}</h1>
      <ErrorState title={PAGE_ERROR.title} message={PAGE_ERROR.message} onRetry={reset} />
    </main>
  );
}
