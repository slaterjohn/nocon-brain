"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/library", label: "Pages" },
  { href: "/library/sources", label: "Sources" },
  { href: "/library/collections", label: "Collections" },
];

/** Sub-navigation for the Library area. Plain links, so it works without script and by keyboard. */
export function LibraryNav() {
  const path = usePathname();
  return (
    <nav aria-label="Library sections" className="mb-5 border-b">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const active = t.href === "/library" ? path === "/library" || path.startsWith("/library/pages") : path.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn("inline-block border-b-2 px-3 py-2 text-sm whitespace-nowrap hover:text-foreground", active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground")}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
