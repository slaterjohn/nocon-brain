import type { Metadata } from "next";
import { NewPackageSourceView } from "@/components/zim/package-source";

export const metadata: Metadata = { title: "New package source" };

export default function Page() {
  return <NewPackageSourceView />;
}
