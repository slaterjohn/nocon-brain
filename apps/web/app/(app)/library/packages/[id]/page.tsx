import type { Metadata } from "next";
import { PackageDetailView } from "@/components/zim/package-detail";

export const metadata: Metadata = { title: "Knowledge package" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PackageDetailView id={id} />;
}
