import type { Metadata } from "next";
import { HistoryView } from "@/components/library/history-view";

export const metadata: Metadata = { title: "History" };

export default function Page() {
  return <HistoryView />;
}
