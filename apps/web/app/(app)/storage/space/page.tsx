import type { Metadata } from "next";
import { SpaceView } from "@/components/storage/space-view";

export const metadata: Metadata = { title: "Storage overview" };

export default function Page() {
  return <SpaceView />;
}
