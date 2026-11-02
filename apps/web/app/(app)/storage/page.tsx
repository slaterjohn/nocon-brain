import type { Metadata } from "next";
import Link from "next/link";
import { Activity, Globe, LayoutDashboard } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/states";

export const metadata: Metadata = { title: "Storage and settings" };

export default function StoragePage() {
  return (
    <>
      <PageHeader title="Storage and settings" description="Check how NoConBrain is running and where it keeps its data." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><LayoutDashboard className="size-4" aria-hidden="true" /> Dashboard</CardTitle>
            <CardDescription>Worker status, storage used and available, and job counts.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/storage/dashboard" className="text-sm text-primary underline underline-offset-2">Open the dashboard</Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="size-4" aria-hidden="true" /> Activity log</CardTitle>
            <CardDescription>What the server has been doing, filtered by level and area.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/storage/activity" className="text-sm text-primary underline underline-offset-2">Open the activity log</Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Globe className="size-4" aria-hidden="true" /> Online search</CardTitle>
            <CardDescription>Search the web as well as your saved pages. Choose providers, limits and privacy.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/storage/online-search" className="text-sm text-primary underline underline-offset-2">Open online search settings</Link>
          </CardContent>
        </Card>
      </div>
      <p className="mt-6 text-sm text-muted-foreground">Volume management, storage priorities and other settings arrive in later releases.</p>
    </>
  );
}
