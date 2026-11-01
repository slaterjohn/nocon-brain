import type { Metadata } from "next";
import { BrowserView } from "@/components/browser/browser-view";

export const metadata: Metadata = { title: "Browser" };

export default function BrowserPage() {
  return <BrowserView />;
}
