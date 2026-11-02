import type { Metadata } from "next";
import { EvictionView } from "@/components/storage/eviction-view";

export const metadata: Metadata = { title: "Removal preview" };

export default function Page() {
  return <EvictionView />;
}
