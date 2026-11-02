import type { Metadata } from "next";
import { EditSourceView } from "@/components/library/source-editor-pages";

export const metadata: Metadata = { title: "Edit source" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditSourceView id={id} />;
}
