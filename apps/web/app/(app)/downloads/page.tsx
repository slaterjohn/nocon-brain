import type { Metadata } from "next";
import { Download } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/layout/states";

export const metadata: Metadata = { title: "Downloads" };

export default function Page() {
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <PageHeader title="Downloads" description="Queued, running and finished downloads." />
      <EmptyState icon={Download} title="No downloads" description="Downloads will be listed here once archiving is built." />
    </div>
  );
}
