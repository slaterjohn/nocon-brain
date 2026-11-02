import type { Metadata } from "next";
import { SearchPage } from "@/components/search/search-page";

export const metadata: Metadata = { title: "Search" };

export default function Page() {
  return <SearchPage />;
}
