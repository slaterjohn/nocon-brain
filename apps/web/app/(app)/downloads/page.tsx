import type { Metadata } from "next";
import { DownloadsView } from "@/components/library/downloads-view";

export const metadata: Metadata = { title: "Downloads" };

export default function Page() {
  return <DownloadsView />;
}
