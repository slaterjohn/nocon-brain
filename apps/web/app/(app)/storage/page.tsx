import type { Metadata } from "next";
import Link from "next/link";
import { Activity, ClipboardList, Eraser, Globe, HardDrive, LayoutDashboard, PieChart, SlidersHorizontal, Wrench, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/states";

export const metadata: Metadata = { title: "Storage and settings" };

const CARDS: { href: string; title: string; text: string; link: string; icon: LucideIcon }[] = [
  { href: "/storage/space", title: "Space and usage", text: "Volumes, what uses the space by priority, source and kind, and a forecast of how it will grow.", link: "Open the storage overview", icon: PieChart },
  { href: "/storage/volumes", title: "Volumes", text: "Add, edit and remove the drives NoConBrain saves to.", link: "Manage volumes", icon: HardDrive },
  { href: "/storage/policy", title: "Policy", text: "When old content may be removed to make room. Protected content is never removed automatically.", link: "Edit the storage policy", icon: SlidersHorizontal },
  { href: "/storage/eviction", title: "Removal preview", text: "See what automatic removal would do, and why, before anything is removed.", link: "Preview a removal", icon: Eraser },
  { href: "/storage/maintenance", title: "Check and repair", text: "Check storage for problems. A check changes nothing. Repairs ask first.", link: "Check storage", icon: Wrench },
  { href: "/storage/audit", title: "Removal record", text: "Every automatic removal and every deletion by hand, with the reason.", link: "Open the removal record", icon: ClipboardList },
  { href: "/storage/dashboard", title: "Dashboard", text: "Worker status, storage used and available, and job counts.", link: "Open the dashboard", icon: LayoutDashboard },
  { href: "/storage/activity", title: "Activity log", text: "What the server has been doing, filtered by level and area.", link: "Open the activity log", icon: Activity },
  { href: "/storage/online-search", title: "Online search", text: "Search the web as well as your saved pages. Choose providers, limits and privacy.", link: "Open online search settings", icon: Globe },
];

export default function StoragePage() {
  return (
    <>
      <PageHeader title="Storage and settings" description="Check how NoConBrain is running and where it keeps its data." />
      <div className="grid gap-4 sm:grid-cols-2">
        {CARDS.map((c) => (
          <Card key={c.href}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><c.icon className="size-4" aria-hidden="true" /> {c.title}</CardTitle>
              <CardDescription>{c.text}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href={c.href} className="text-sm text-primary underline underline-offset-2">{c.link}</Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
