import type { Metadata } from "next";
import { CollectionsView } from "@/components/library/collections-view";

export const metadata: Metadata = { title: "Collections" };

export default function Page() {
  return <CollectionsView />;
}
