import { Compass, Download, HardDrive, Library, Search, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra path prefixes that count as this area. */
  also?: string[];
}

// The five areas. Browser is the default landing page.
export const areas: NavItem[] = [
  { href: "/", label: "Browser", icon: Compass, also: ["/bookmarks", "/history", "/save"] },
  { href: "/library", label: "Library", icon: Library },
  { href: "/downloads", label: "Downloads", icon: Download },
  { href: "/search", label: "Search", icon: Search },
  { href: "/storage", label: "Storage and settings", icon: HardDrive },
];

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.href === "/") return pathname === "/" || (item.also ?? []).some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
