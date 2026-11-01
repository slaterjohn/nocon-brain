import type { Metadata } from "next";
import { Library } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/layout/states";

export const metadata: Metadata = { title: "Library" };

export default function Page() {
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <PageHeader title="Library" description="Pages, sources and collections you have saved." />
      <EmptyState icon={Library} title="Nothing saved yet" description="Pages you archive will appear here. Archiving arrives in a later release." />
    </div>
  );
}
