import type { Metadata } from "next";
import { MaintenanceView } from "@/components/storage/maintenance-view";

export const metadata: Metadata = { title: "Check and repair" };

export default function Page() {
  return <MaintenanceView />;
}
