import type { Metadata } from "next";
import { SearchPlaceholder } from "@/components/search/search-placeholder";

export const metadata: Metadata = { title: "Search" };

export default function Page() {
  return <SearchPlaceholder />;
}
