import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_ALLOTMENT, MIN_ALLOTMENT, plan, type PlanCandidate, type PlanInput } from "../../apps/server/src/discovery/planner.js";
import { buildDiscoverySchema, effectiveLimits, profileMaximums, validateDiscoverySettings } from "../../apps/server/src/discovery/settings.js";
import { articleUrls, automatic, flood, seedSourcePage, startDiscoveryTest, useFixtures } from "./helpers.js";

const MIB = 1024 * 1024;
const HOSTS = ["a.example", "b.example", "c.example", "d.example", "127.0.0.1"];
const big = (max: number) => fc.integer({ min: 0, max });

const candidate = fc.record({
  id: fc.integer({ min: 1, max: 1_000_000 }),
  host: fc.constantFrom(...HOSTS),
  depth: fc.integer({ min: 0, max: 12 }),
  estimatedBytes: fc.option(fc.integer({ min: 0, max: 200 * MIB }), { nil: null }),
  sourceId: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
});

const input = fc.record({
  maxDepth: fc.integer({ min: 1, max: 12 }),
  maxQueued: big(80), maxCandidatesPerRun: big(80), perSiteDailyCap: big(40), inFlight: big(120),
  requests: fc.record({ max: big(500), used: big(800) }),
  bytes: fc.record({ max: big(500 * MIB), used: big(800 * MIB) }),
  siteUsed: fc.array(fc.tuple(fc.constantFrom(...HOSTS), big(60)), { maxLength: 5 }).map((e) => new Map(e)),
  storageRoom: big(300 * MIB),
  sourceRoom: fc.array(fc.tuple(fc.integer({ min: 1, max: 4 }), big(100 * MIB)), { maxLength: 4 }).map((e) => new Map(e)),
  candidates: fc.array(candidate, { maxLength: 150 }).map((cs) => cs.map((c, i) => ({ ...c, id: i + 1 }) as PlanCandidate)),
}) as fc.Arbitrary<PlanInput>;

describe("random settings never produce unbounded work (D-06)", () => {
  it("the planner never starts more than any limit allows, whatever the numbers and however many candidates", () => {
    fc.assert(
      fc.property(input, (i) => {
        const out = plan(i);
        const n = out.start.length;
        expect(n).toBeLessThanOrEqual(i.maxCandidatesPerRun);
        expect(n).toBeLessThanOrEqual(Math.max(0, i.maxQueued - i.inFlight));
        expect(n).toBeLessThanOrEqual(Math.max(0, i.requests.max - i.requests.used));
        const total = out.start.reduce((s, x) => s + x.allotment, 0);
        expect(total).toBeLessThanOrEqual(Math.max(0, i.bytes.max - i.bytes.used));
        expect(total).toBeLessThanOrEqual(i.storageRoom);
        const perHost = new Map<string, number>();
        const perSource = new Map<number, number>();
        const byId = new Map(i.candidates.map((c) => [c.id, c]));
        for (const s of out.start) {
          const c = byId.get(s.id)!;
          expect(c.depth).toBeLessThanOrEqual(i.maxDepth);
          expect(s.allotment).toBeGreaterThanOrEqual(MIN_ALLOTMENT);
          expect(s.allotment).toBeLessThanOrEqual(MAX_ALLOTMENT);
          perHost.set(s.host, (perHost.get(s.host) ?? 0) + 1);
          if (s.sourceId !== null) perSource.set(s.sourceId, (perSource.get(s.sourceId) ?? 0) + s.allotment);
        }
        for (const [h, k] of perHost) expect(k + (i.siteUsed.get(h) ?? 0)).toBeLessThanOrEqual(Math.max(i.perSiteDailyCap, i.siteUsed.get(h) ?? 0));
        for (const [sid, bytes] of perSource) if (i.sourceRoom.has(sid)) expect(bytes).toBeLessThanOrEqual(i.sourceRoom.get(sid)!);
        // Nothing is chosen twice; everything is either started or skipped.
        expect(new Set(out.start.map((s) => s.id)).size).toBe(n);
        expect(out.start.length + out.skipped.length).toBe(i.candidates.length);
      }),
      { numRuns: 1500 },
    );
  });

  it("settings of any size are clamped to the profile maximum, and valid settings stay under their ceiling", () => {
    const schema = buildDiscoverySchema();
    const huge = fc.integer({ min: 0, max: 2 ** 40 });
    fc.assert(
      fc.property(
        fc.constantFrom("pi-lite" as const, "standard" as const),
        fc.record({
          active: fc.record({ maxDepth: fc.integer({ min: 1, max: 100 }), maxQueued: fc.integer({ min: 1, max: 2 ** 40 }), maxCandidatesPerRun: fc.integer({ min: 1, max: 2 ** 40 }), maxBytesPerDay: huge, maxRequestsPerDay: huge, perSiteDailyCap: fc.integer({ min: 1, max: 2 ** 40 }) }),
          ceilings: fc.record({ maxDepth: fc.integer({ min: 1, max: 2 ** 40 }), maxQueued: fc.integer({ min: 1, max: 2 ** 40 }), maxRequestsPerDay: huge, maxBytesPerDay: huge }),
          searchDriven: fc.record({ backgroundBudget: fc.record({ maxRequestsPerDay: huge, maxBytesPerDay: huge }) }),
          pool: fc.record({ maxCandidates: fc.integer({ min: 1, max: 2 ** 40 }) }),
        }),
        (profile, raw) => {
          const d = schema.parse(raw);
          const max = profileMaximums(profile);
          const eff = effectiveLimits(d, profile);
          // However large the numbers, what is in force never exceeds the profile maximum…
          expect(eff.maxDepth).toBeLessThanOrEqual(max.maxDepth);
          expect(eff.maxQueued).toBeLessThanOrEqual(max.maxQueued);
          expect(eff.maxCandidates).toBeLessThanOrEqual(max.maxCandidates);
          expect(eff.maxCandidatesPerRun).toBeLessThanOrEqual(eff.maxQueued);
          for (const lane of [eff.active, eff.background]) {
            expect(lane.maxRequestsPerDay).toBeLessThanOrEqual(max.maxRequestsPerDay);
            expect(lane.maxBytesPerDay).toBeLessThanOrEqual(max.maxBytesPerDay);
          }
          expect(eff.perSiteDailyCap).toBeLessThanOrEqual(max.maxRequestsPerDay);
          // …and a ceiling above the maximum, or a limit above the ceiling, is refused when saving.
          const issues = validateDiscoverySettings(d, profile).map((x) => x.path);
          if (d.ceilings.maxDepth > max.maxDepth) expect(issues).toContain("ceilings.maxDepth");
          if (d.ceilings.maxBytesPerDay > max.maxBytesPerDay) expect(issues).toContain("ceilings.maxBytesPerDay");
          if (d.ceilings.maxRequestsPerDay > max.maxRequestsPerDay) expect(issues).toContain("ceilings.maxRequestsPerDay");
          if (d.ceilings.maxQueued > max.maxQueued) expect(issues).toContain("ceilings.maxQueued");
          if (d.active.maxDepth > d.ceilings.maxDepth) expect(issues).toContain("active.maxDepth");
          if (issues.length === 0) {
            expect(d.ceilings.maxDepth).toBeLessThanOrEqual(max.maxDepth);
            expect(d.active.maxBytesPerDay).toBeLessThanOrEqual(d.ceilings.maxBytesPerDay);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("random valid settings against a real server and a flood of candidates", () => {
  const fixtures = useFixtures();

  it("requests, bytes, sites, queue and depth stay inside the limits over several passes", async () => {
    const origin = fixtures().urls.article as string;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          maxCandidatesPerRun: fc.integer({ min: 1, max: 12 }), maxQueued: fc.integer({ min: 1, max: 15 }), maxRequestsPerDay: fc.integer({ min: 0, max: 14 }),
          maxBytesPerDay: fc.integer({ min: 0, max: 6 * MIB }), perSiteDailyCap: fc.integer({ min: 1, max: 12 }), maxDepth: fc.integer({ min: 1, max: 3 }),
          passes: fc.integer({ min: 1, max: 4 }), mode: fc.constantFrom("automatic" as const, "approval" as const),
          depths: fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 12, maxLength: 20 }),
        }),
        async (p) => {
          const t = await startDiscoveryTest({ hold: true });
          const src = await seedSourcePage(t);
          const urls = articleUrls(origin, p.depths.length);
          p.depths.forEach((depth, i) => flood(t, { urls: [urls[i]!], refPageId: src.pageId, depth, state: p.mode === "approval" ? "approved" : "new" }));
          const r = await t.settings(automatic(src.sourcePublicId, {
            mode: p.mode, maxCandidatesPerRun: p.maxCandidatesPerRun, maxQueued: p.maxQueued, maxRequestsPerDay: p.maxRequestsPerDay, maxBytesPerDay: p.maxBytesPerDay,
            perSiteDailyCap: p.perSiteDailyCap, maxDepth: p.maxDepth,
          }));
          expect(r.status).toBe(200);
          let perPass = 0;
          for (let i = 0; i < p.passes; i++) {
            const rep = t.svc.discovery.runner.runPass("manual");
            perPass = Math.max(perPass, rep.active.started);
          }
          const jobs = t.svc.db.all<{ requested_url: string }>("SELECT requested_url FROM download_jobs WHERE requested_by = 'discovery'");
          const ledger = t.svc.db.all<{ requests: number; reserved_bytes: number }>("SELECT requests, reserved_bytes FROM discovery_ledger");
          expect(perPass).toBeLessThanOrEqual(p.maxCandidatesPerRun);
          expect(jobs.length).toBeLessThanOrEqual(p.maxQueued);
          expect(jobs.length).toBeLessThanOrEqual(p.maxRequestsPerDay);
          expect(jobs.length).toBeLessThanOrEqual(p.perSiteDailyCap);
          expect(ledger.reduce((n, l) => n + l.requests, 0)).toBeLessThanOrEqual(p.maxRequestsPerDay);
          expect(ledger.reduce((n, l) => n + l.reserved_bytes, 0)).toBeLessThanOrEqual(p.maxBytesPerDay);
          const started = new Set(jobs.map((j) => j.requested_url));
          p.depths.forEach((d, i) => { if (d > p.maxDepth) expect(started.has(urls[i]!), `depth ${d} > ${p.maxDepth}`).toBe(false); });
          await t.server.close();
        },
      ),
      { numRuns: 8 },
    );
  });
});
