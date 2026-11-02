import type { Metadata } from "next";
import { CandidatesView } from "@/components/discovery/candidates-view";

export const metadata: Metadata = { title: "Discovery" };

export default function Page() {
  return <CandidatesView />;
}
