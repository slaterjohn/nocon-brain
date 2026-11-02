"use client";

import { useSearchParams } from "next/navigation";
import { ResultsView } from "./results-view";
import { SearchArea } from "./search-area";

/** /search?q=… is the results page; /search alone is the Search area. */
export function SearchPage() {
  const q = useSearchParams().get("q");
  return q && q.trim() ? <ResultsView /> : <SearchArea />;
}
