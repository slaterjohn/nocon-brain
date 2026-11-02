import type { Metadata } from "next";
import { DiscoverySettingsView } from "@/components/discovery/settings-view";

export const metadata: Metadata = { title: "Discovery settings" };

export default function Page() {
  return <DiscoverySettingsView />;
}
