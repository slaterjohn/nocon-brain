import type { Metadata } from "next";
import { AuditView } from "@/components/storage/audit-view";

export const metadata: Metadata = { title: "Removal record" };

export default function Page() {
  return <AuditView />;
}
