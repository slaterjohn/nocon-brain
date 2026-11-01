import type { Metadata } from "next";
import { SetupWizard } from "@/components/setup/wizard";

export const metadata: Metadata = { title: "Set up" };

export default function SetupPage() {
  return <SetupWizard />;
}
