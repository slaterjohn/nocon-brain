import { describe, expect, it } from "vitest";
import { eligibility, passesGate, type Priority, type SkipReason } from "../src/index.js";
import { NOW, page, ref, ver } from "./helpers.js";

const P: Priority[] = [1, 2, 3, 4];

/** Page with an older (surplus under latest(1)) version 1 and a current version 2, one reference of priority `p`. */
const mk = (p: Priority, autoEvict: boolean) => page(1, [ver(1), ver(2)], [ref({ priority: p, autoEvict })]);

/** Expected outcome for the CURRENT version, written out from the rules rather than by calling the code under test. */
function expectedCurrent(p: Priority, flag: boolean, permit: boolean, incoming: Priority): { eligible: boolean; reason?: SkipReason } {
  if (p === 1) return { eligible: false, reason: "p1" };
  if (!flag) return { eligible: false, reason: "source_auto_eviction_off" };
  if (p === 2 && !permit) return { eligible: false, reason: "p2_not_permitted" };
  const gate = p > incoming || (p === incoming && (incoming === 3 || incoming === 4));
  return gate ? { eligible: true } : { eligible: false, reason: "priority_gate" };
}

describe("T-03 truth table: priority x source flag x permit x incoming priority (current version)", () => {
  const rows: [Priority, boolean, boolean, Priority][] = [];
  for (const p of P) for (const flag of [true, false]) for (const permit of [true, false]) for (const q of P) rows.push([p, flag, permit, q]);
  it.each(rows)("P%i, autoEvict=%s, permit=%s, incoming P%i", (p, flag, permit, q) => {
    const e = eligibility({ page: mk(p, flag), versionId: 2, policy: { permitImportantEviction: permit }, incomingPriority: q, now: NOW });
    const want = expectedCurrent(p, flag, permit, q);
    expect(e.eligible).toBe(want.eligible);
    if (!e.eligible) expect(e.reason).toBe(want.reason);
  });
});

describe("T-03 explicit cases", () => {
  it("a P1 source with automaticEviction=true: the current version is NOT eligible, for any incoming priority and permit", () => {
    for (const q of P) for (const permit of [true, false]) {
      const e = eligibility({ page: mk(1, true), versionId: 2, policy: { permitImportantEviction: permit }, incomingPriority: q, now: NOW });
      expect(e).toMatchObject({ eligible: false, reason: "p1" });
    }
  });
  it("a surplus version of a P1 source with the flag true is eligible", () => {
    const e = eligibility({ page: mk(1, true), versionId: 1, policy: { permitImportantEviction: false }, incomingPriority: 1, now: NOW });
    expect(e).toMatchObject({ eligible: true, surplus: true, priority: 4 });
  });
  it("a surplus version of a P1 source with the flag false is not eligible (page-level veto)", () => {
    const e = eligibility({ page: mk(1, false), versionId: 1, policy: { permitImportantEviction: true }, incomingPriority: 1, now: NOW });
    expect(e).toMatchObject({ eligible: false, reason: "source_auto_eviction_off" });
  });
  it("one non-retaining reference with autoEvict=false still vetoes the page", () => {
    const pg = page(1, [ver(1), ver(2)], [ref({ priority: 4 }), ref({ id: "src_b", priority: 4, autoEvict: false })]);
    expect(eligibility({ page: pg, versionId: 2, policy: { permitImportantEviction: false }, incomingPriority: 1, now: NOW })).toMatchObject({ eligible: false, reason: "source_auto_eviction_off" });
  });
  it("P1 from one reference wins over a P4 reference that would allow eviction", () => {
    const pg = page(1, [ver(2)], [ref({ priority: 4 }), ref({ id: "src_b", priority: 1 })]);
    expect(eligibility({ page: pg, versionId: 2, policy: { permitImportantEviction: true }, incomingPriority: 4, now: NOW })).toMatchObject({ eligible: false, reason: "p1" });
  });
  it("a P1 pin vetoes the page: its older surplus versions stay too", () => {
    const pg = page(1, [ver(1), ver(2)], [ref({ kind: "pin", id: "pin", priority: 1, autoEvict: false })]);
    expect(eligibility({ page: pg, versionId: 1, policy: { permitImportantEviction: true }, incomingPriority: 1, now: NOW })).toMatchObject({ eligible: false, reason: "source_auto_eviction_off" });
  });
  it("busy pages and versions that are not ready/partial are in use", () => {
    expect(eligibility({ page: page(1, [ver(1)], [ref({ priority: 4 })], { busy: true }), versionId: 1, policy: { permitImportantEviction: false }, incomingPriority: 1, now: NOW })).toMatchObject({ reason: "in_use" });
    for (const status of ["capturing", "failed", "evicting", "evicted"] as const) {
      expect(eligibility({ page: page(1, [ver(1, { status })], [ref({ priority: 4 })]), versionId: 1, policy: { permitImportantEviction: false }, incomingPriority: 1, now: NOW })).toMatchObject({ eligible: false, reason: "in_use" });
    }
  });
  it("an unknown version id is not eligible", () => {
    expect(eligibility({ page: mk(4, true), versionId: 99, policy: { permitImportantEviction: true }, incomingPriority: 1, now: NOW }).eligible).toBe(false);
  });
  it("the incoming gate: a P4 download reclaims only P4, P3 reclaims P3 and P4, P1 and P2 reclaim P3/P4 (and P2 for P1 if permitted)", () => {
    expect([1, 2, 3, 4].map((c) => passesGate(c as Priority, 4))).toEqual([false, false, false, true]);
    expect([1, 2, 3, 4].map((c) => passesGate(c as Priority, 3))).toEqual([false, false, true, true]);
    expect([1, 2, 3, 4].map((c) => passesGate(c as Priority, 2))).toEqual([false, false, true, true]);
    expect([1, 2, 3, 4].map((c) => passesGate(c as Priority, 1))).toEqual([false, true, true, true]);
  });
});
