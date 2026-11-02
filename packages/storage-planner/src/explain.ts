import { eligibility } from "./eligibility.js";
import { latestLive } from "./retention.js";
import type { PageInfo, Policy, Priority, Reference, SkipReason } from "./types.js";

export interface ReferenceSummary {
  kind: Reference["kind"];
  id: string;
  label?: string;
  priority: Priority;
  autoEvict: boolean;
  retains: boolean;
}

export interface VersionExplanation {
  versionId: number;
  status: string;
  isLatest: boolean;
  priority: Priority;
  surplus: boolean;
  /** `kept`: automatic eviction can never remove it right now. `evictable`: it can be reclaimed when space is needed. */
  decision: "kept" | "evictable";
  skipReason?: SkipReason;
  references: ReferenceSummary[];
  /** Plain-English sentences, most important first. */
  reasons: string[];
}

const name = (p: Priority): string => ({ 1: "Protected", 2: "Important", 3: "Standard", 4: "Opportunistic" })[p];
const refName = (r: Reference): string => `${r.kind === "source" ? "source" : r.kind === "collection" ? "collection" : r.kind} ${r.label ?? r.id}`;

/** "Why is this version kept (or what would let it be evicted)?" Pure; the same rules as the eligibility function, in words. */
export function explainVersion(
  page: PageInfo, versionId: number, policy: Pick<Policy, "permitImportantEviction">, now: number, incomingPriority: Priority = 1,
): VersionExplanation {
  const e = eligibility({ page, versionId, policy, incomingPriority, now });
  const retaining = new Set(e.retainingRefs);
  const references = page.refs.map((r) => ({ kind: r.kind, id: r.id, label: r.label, priority: r.priority, autoEvict: r.autoEvict, retains: retaining.has(r) }));
  const latest = latestLive(page);
  const reasons: string[] = [];
  const keepers = e.retainingRefs.filter((r) => r.priority === e.priority);
  if (e.surplus) reasons.push("No source, collection, pin or bookmark retains this copy any more, so it counts as opportunistic (P4) surplus.");
  else reasons.push(`${name(e.priority)} (P${e.priority}): retained by ${keepers.map(refName).join(", ")}.`);
  if (!e.eligible) {
    switch (e.reason) {
      case "p1": reasons.push("Protected content is never removed automatically, whatever the eviction settings say."); break;
      case "source_auto_eviction_off": {
        const v = page.refs.find((r) => !r.autoEvict);
        reasons.push(`${v ? refName(v) : "A reference"} does not allow automatic eviction, which protects every copy of this page.`);
        break;
      }
      case "p2_not_permitted": reasons.push("Important (P2) content can only be evicted when the storage policy permits it, and it does not."); break;
      case "priority_gate": reasons.push(`A P${incomingPriority} download may only reclaim content less important than itself.`); break;
      case "in_use": reasons.push("A download is writing to this page, or this copy is not complete, so it is left alone."); break;
      default: break;
    }
  } else {
    reasons.push(e.surplus ? "It can be removed when space is needed, before any other content." : `It can be removed when space is needed, after less important content.`);
    if (latest?.id === versionId && !e.surplus) reasons.push("It is the current copy of the page; older copies would go first.");
  }
  return {
    versionId, status: page.versions.find((v) => v.id === versionId)?.status ?? "unknown", isLatest: latest?.id === versionId, priority: e.priority, surplus: e.surplus,
    decision: e.eligible ? "evictable" : "kept", ...(e.eligible ? {} : { skipReason: e.reason }), references, reasons,
  };
}
