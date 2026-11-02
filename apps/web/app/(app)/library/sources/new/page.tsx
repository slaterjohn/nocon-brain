import type { Metadata } from "next";
import { NewSourceView } from "@/components/library/source-editor-pages";

export const metadata: Metadata = { title: "New source" };

export default function Page() {
  return <NewSourceView />;
}
