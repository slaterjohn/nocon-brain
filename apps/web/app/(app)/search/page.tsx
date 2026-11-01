import type { Metadata } from "next";
import { Search } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/layout/states";

export const metadata: Metadata = { title: "Search" };

export default function Page() {
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <PageHeader title="Search" description="Search saved pages and, if you allow it, the web." />
      <EmptyState icon={Search} title="Search isn't connected yet" description="Local and online search arrive in a later release." />
    </div>
  );
}
