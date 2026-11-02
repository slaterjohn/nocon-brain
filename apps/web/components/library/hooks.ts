"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/api";
import type { Collection, Page, Source } from "@/lib/types";

export function useSources() {
  const q = useApi<Page<Source>>("/api/sources?limit=200", { refreshInterval: 5000 });
  const byId = useMemo(() => new Map((q.data?.items ?? []).map((s) => [s.id, s])), [q.data]);
  return { ...q, sources: q.data?.items ?? [], byId };
}

export function flattenCollections(nodes: Collection[], depth = 0, out: (Collection & { depth: number })[] = []) {
  for (const n of nodes) {
    out.push({ ...n, depth });
    if (n.children?.length) flattenCollections(n.children, depth + 1, out);
  }
  return out;
}

export function useCollections() {
  const q = useApi<{ items: Collection[] }>("/api/collections?tree=true");
  const flat = useMemo(() => flattenCollections(q.data?.items ?? []), [q.data]);
  const byId = useMemo(() => new Map(flat.map((c) => [c.id, c])), [flat]);
  return { ...q, tree: q.data?.items ?? [], flat, byId };
}
