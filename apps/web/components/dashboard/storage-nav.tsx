"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items = [
  { href: "/storage", label: "Settings" },
  { href: "/storage/space", label: "Space" },
  { href: "/storage/volumes", label: "Volumes" },
  { href: "/storage/policy", label: "Policy" },
  { href: "/storage/eviction", label: "Removal preview" },
  { href: "/storage/maintenance", label: "Check and repair" },
  { href: "/storage/audit", label: "Removal record" },
  { href: "/storage/dashboard", label: "Dashboard" },
  { href: "/storage/activity", label: "Activity log" },
  { href: "/storage/online-search", label: "Online search" },
  { href: "/storage/packages", label: "Knowledge packages" },
];

/** Local navigation inside the Storage and settings area. */
export function StorageNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Storage and settings sections" className="mb-6 border-b">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {items.map((i) => {
          const active = pathname === i.href || (i.href === "/storage/audit" && pathname.startsWith("/storage/pages/"));
          return (
            <li key={i.href}>
              <Link
                href={i.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap hover:bg-accent",
                  active && "border-primary font-medium",
                )}
              >
                {i.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
