import type { Metadata } from "next";
import { PackagesView } from "@/components/zim/packages-view";

export const metadata: Metadata = { title: "Knowledge packages" };

export default function Page() {
  return <PackagesView />;
}
