import type { Metadata } from "next";
import { OnlineSearchSettings } from "@/components/search/providers-settings";

export const metadata: Metadata = { title: "Online search" };

export default function Page() {
  return <OnlineSearchSettings />;
}
