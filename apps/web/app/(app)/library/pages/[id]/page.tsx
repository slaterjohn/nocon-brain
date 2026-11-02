import type { Metadata } from "next";
import { PageDetailView } from "@/components/library/page-detail";

export const metadata: Metadata = { title: "Saved page" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PageDetailView id={id} />;
}
