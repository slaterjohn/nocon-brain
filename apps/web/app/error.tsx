"use client";

import { ErrorState } from "@/components/layout/states";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="mx-auto max-w-xl p-6">
      <h1 className="sr-only">Something went wrong</h1>
      <ErrorState title="Something went wrong" message={error.message || "An unexpected error stopped this page. Try again."} onRetry={reset} />
    </main>
  );
}
