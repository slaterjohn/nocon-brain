"use client";

import * as React from "react";
import { get, useApi } from "@/lib/api";
import type { ZimList, ZimPackage } from "@/lib/zim";

/** The installed knowledge packages. Polls while one is still being copied. */
export function usePackages(opts: { enabled?: boolean } = {}) {
  const [copying, setCopying] = React.useState(false);
  const q = useApi<ZimList>("/api/zim/packages", { refreshInterval: copying ? 2000 : 15_000, enabled: opts.enabled });
  const items = q.data?.items ?? [];
  const anyCopying = items.some((p) => p.state === "importing");
  React.useEffect(() => setCopying(anyCopying), [anyCopying]);
  const byId = React.useMemo(() => new Map(items.map((p) => [p.id, p])), [items]);
  return { ...q, packages: items, byId };
}

const known = new Map<string, Promise<ZimPackage | null>>();

/** One package's details, kept for the visit so the browser chrome can name the package a tab shows. */
export function usePackageSummary(id: string | undefined): ZimPackage | null {
  const [pkg, setPkg] = React.useState<ZimPackage | null>(null);
  React.useEffect(() => {
    setPkg(null);
    if (!id) return;
    let live = true;
    let p = known.get(id);
    if (!p) {
      p = get<ZimPackage>(`/api/zim/packages/${encodeURIComponent(id)}`).catch(() => null);
      known.set(id, p);
    }
    void p.then((v) => {
      if (!v) known.delete(id);
      if (live) setPkg(v);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return pkg;
}

/** Looks a package up for the browser (no hook), caching what it finds. */
export function fetchPackage(id: string): Promise<ZimPackage | null> {
  let p = known.get(id);
  if (!p) {
    p = get<ZimPackage>(`/api/zim/packages/${encodeURIComponent(id)}`).catch(() => null);
    known.set(id, p);
  }
  return p.then((v) => {
    if (!v) known.delete(id);
    return v;
  });
}
