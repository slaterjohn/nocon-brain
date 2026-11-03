import type { Metadata } from "next";
import { WikipediaView } from "@/components/zim/wikipedia-view";

export const metadata: Metadata = { title: "Wikipedia topic" };

export default function Page() {
  return <WikipediaView />;
}
