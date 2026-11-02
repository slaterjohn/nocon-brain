import type { Metadata } from "next";
import { PolicyView } from "@/components/storage/policy-view";

export const metadata: Metadata = { title: "Storage policy" };

export default function Page() {
  return <PolicyView />;
}
