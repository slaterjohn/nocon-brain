"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items = [
  { href: "/discovery", label: "Suggestions" },
  { href: "/discovery/budget", label: "Budget and runner" },
  { href: "/discovery/settings", label: "Settings" },
];

/** Local navigation inside the Discovery area. */
export function DiscoveryNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Discovery sections" className="mb-6 border-b">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {items.map((i) => {
          const active = pathname === i.href;
          return (
            <li key={i.href}>
              <Link
                href={i.href}
                aria-current={active ? "page" : undefined}
                className={cn("inline-block border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap hover:bg-accent", active && "border-primary font-medium")}
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
