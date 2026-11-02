import type { Metadata } from "next";
import { VolumesView } from "@/components/storage/volumes-view";

export const metadata: Metadata = { title: "Volumes" };

export default function Page() {
  return <VolumesView />;
}
