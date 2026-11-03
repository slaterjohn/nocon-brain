import type { Metadata } from "next";
import { ZimSettingsView } from "@/components/zim/settings-view";

export const metadata: Metadata = { title: "Knowledge package settings" };

export default function Page() {
  return <ZimSettingsView />;
}
