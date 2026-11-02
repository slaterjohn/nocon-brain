import type { Metadata } from "next";
import { BudgetView } from "@/components/discovery/budget-view";

export const metadata: Metadata = { title: "Discovery budget and runner" };

export default function Page() {
  return <BudgetView />;
}
