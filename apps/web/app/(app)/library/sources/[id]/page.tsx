import type { Metadata } from "next";
import { SourceDetailView } from "@/components/library/source-detail";

export const metadata: Metadata = { title: "Source" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SourceDetailView id={id} />;
}
