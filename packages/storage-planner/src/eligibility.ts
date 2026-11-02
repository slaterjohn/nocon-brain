import { isLive } from "./retention.js";
import { versionPriority, type PriorityResult } from "./priority.js";
import type { PageInfo, Policy, Priority, SkipReason } from "./types.js";

export interface EligibilityInput {
  page: PageInfo;
  versionId: number;
  policy: Pick<Policy, "permitImportantEviction">;
  /**
   * The priority of the download that needs the space (docs/data-model.md 5.2 rule 7). Maintenance eviction with no incoming job
   * passes 1, so the gate lets every class through.
   */
  incomingPriority: Priority;
  now: number;
}

export type Eligibility =
  | ({ eligible: true } & PriorityResult)
  | ({ eligible: false; reason: SkipReason; vetoedBy?: string } & PriorityResult);

/** Rule 7: may a candidate of class `candidate` be reclaimed for an incoming download of priority `incoming`? */
export function passesGate(candidate: Priority, incoming: Priority): boolean {
  return candidate > incoming || (candidate === incoming && (incoming === 3 || incoming === 4));
}

/**
 * Eligibility for automatic eviction (docs/data-model.md 5.2), in the order of the rules. The reason of the first rule that
 * fails is returned. Pure: the planner calls it to choose and the executor calls it again inside its transaction.
 *
 *   1. the version is ready or partial and no job is writing to the page
 *   2. P1 is absolute: a version whose priority is 1 is never eligible, whatever any flag says
 *   3. automaticEviction is a veto at page level: one active reference with autoEvict=false protects the whole page
 *   4. the class is priority(V), with surplus counting as 4
 *   5. P2 only under the global permit
 *   6. P3 and P4 are eligible
 *   7. the incoming-priority gate
 */
export function eligibility(i: EligibilityInput): Eligibility {
  const v = i.page.versions.find((x) => x.id === i.versionId);
  const pr = v ? versionPriority(i.page, i.versionId, i.now) : { priority: 4 as Priority, surplus: true, retainingRefs: [] };
  const no = (reason: SkipReason, vetoedBy?: string): Eligibility => ({ eligible: false, reason, ...(vetoedBy ? { vetoedBy } : {}), ...pr });
  if (!v || !isLive(v) || i.page.busy) return no("in_use");
  if (pr.priority === 1 && !pr.surplus) return no("p1");
  const veto = i.page.refs.find((r) => !r.autoEvict);
  if (veto) return no("source_auto_eviction_off", veto.id);
  if (pr.priority === 2 && !i.policy.permitImportantEviction) return no("p2_not_permitted");
  if (!passesGate(pr.priority, i.incomingPriority)) return no("priority_gate");
  return { eligible: true, ...pr };
}
