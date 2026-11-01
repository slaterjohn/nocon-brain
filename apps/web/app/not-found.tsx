import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/layout/states";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-xl p-6">
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        title="That page doesn't exist"
        description="Check the address, or go back to the browser."
        action={<Button asChild><Link href="/">Go to the browser</Link></Button>}
      />
    </main>
  );
}
