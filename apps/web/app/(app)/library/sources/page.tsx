import type { Metadata } from "next";
import { SourcesView } from "@/components/library/sources-view";

export const metadata: Metadata = { title: "Sources" };

export default function Page() {
  return <SourcesView />;
}
