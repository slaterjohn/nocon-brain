import type { Metadata } from "next";
import { Suspense } from "react";
import { SaveView } from "@/components/library/save-view";

export const metadata: Metadata = { title: "Save a page" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <SaveView />
    </Suspense>
  );
}
