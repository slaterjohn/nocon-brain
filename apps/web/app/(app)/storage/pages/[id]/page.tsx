import type { Metadata } from "next";
import { PageWhyView } from "@/components/storage/page-why-view";

export const metadata: Metadata = { title: "Why is this page kept?" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PageWhyView id={id} />;
}
