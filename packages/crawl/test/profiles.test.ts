import { describe, expect, it } from "vitest";
import {
  CrawlConfigError, HARD_CEILINGS, MIN_DELAY_MS, PROFILES, resolveCrawlConfig, validateCrawlConfig, type ProfileName, type ResourceProfile,
} from "../src/index.js";

const U = ["https://www.example.com/docs/start"];
const names = ["focused", "balanced", "comprehensive"] as const;
const resources: ResourceProfile[] = ["pi-lite", "standard"];

describe("profile data", () => {
  for (const r of resources) {
    it(`every preset is inside the ${r} hard ceilings`, () => {
      const c = HARD_CEILINGS[r];
      for (const n of names) {
        const p = PROFILES[n][r];
        expect(p.maxPages, n).toBeLessThanOrEqual(c.maxPages);
        expect(p.maxDepth, n).toBeLessThanOrEqual(c.maxDepth);
        expect(p.maxBytes, n).toBeLessThanOrEqual(c.maxBytes);
        expect(p.maxDurationMs, n).toBeLessThanOrEqual(c.maxDurationMs);
        expect(p.maxFrontier, n).toBeLessThanOrEqual(c.maxFrontier);
        expect(p.maxUrlsPerHost, n).toBeLessThanOrEqual(c.maxUrlsPerHost);
      }
    });
  }
  it("grows from focused to balanced to comprehensive", () => {
    for (const r of resources) {
      const [f, b, c] = names.map((n) => PROFILES[n][r]);
      expect(f!.maxPages).toBeLessThan(b!.maxPages);
      expect(b!.maxPages).toBeLessThan(c!.maxPages);
      expect(f!.maxDepth).toBeLessThan(b!.maxDepth);
      expect(b!.maxDepth).toBeLessThan(c!.maxDepth);
      expect(f!.regions.length).toBeLessThan(b!.regions.length);
      expect(b!.regions.length).toBeLessThan(c!.regions.length);
    }
  });
  it("pi-lite caps are smaller than standard for the same profile", () => {
    for (const n of names) {
      expect(PROFILES[n]["pi-lite"].maxPages).toBeLessThan(PROFILES[n].standard.maxPages);
      expect(PROFILES[n]["pi-lite"].maxBytes).toBeLessThanOrEqual(PROFILES[n].standard.maxBytes);
    }
  });
  it("focused follows the main article and headings only", () => {
    expect(PROFILES.focused.standard.regions).toEqual(["content", "heading"]);
  });
  it("politeness floors match the architecture table", () => {
    expect(MIN_DELAY_MS).toEqual({ "pi-lite": 1500, standard: 1000 });
  });
});

describe("resolveCrawlConfig", () => {
  it.each(names.flatMap((n) => resources.map((r) => [n, r] as const)))("%s on %s maps to its documented caps", (profile, resource) => {
    const c = resolveCrawlConfig({ startUrls: U, mode: "explore", profile, resource });
    const p = PROFILES[profile][resource];
    expect(c.limits).toEqual({ maxPages: p.maxPages, maxBytes: p.maxBytes, maxDurationMs: p.maxDurationMs });
    expect(c.scope.maxDepth).toBe(p.maxDepth);
    expect(c.links.regions).toEqual(p.regions);
    expect(c.politeness).toEqual({ minDelayMs: MIN_DELAY_MS[resource], perHostConcurrency: 1, assetConcurrency: 1 });
    expect(c.traps.queryVariantBudget).toBe(p.queryVariantBudget);
    expect(validateCrawlConfig(c)).toEqual([]);
  });

  it("defaults to balanced on standard", () => {
    const c = resolveCrawlConfig({ startUrls: U, mode: "explore" });
    expect([c.profile, c.resource]).toEqual(["balanced", "standard"]);
  });

  it("capture saves one page", () => {
    const c = resolveCrawlConfig({ startUrls: U, mode: "capture" });
    expect(c.limits.maxPages).toBe(1);
    expect(c.scope.maxDepth).toBe(0);
    expect(c.scope.externalDepth).toBe(0);
  });

  it("mirror follows every region and stays on the site", () => {
    const c = resolveCrawlConfig({ startUrls: U, mode: "mirror", profile: "focused" });
    expect(c.links.regions).toEqual(["content", "heading", "related", "nav", "footer", "other"]);
    expect(c.scope.internal).toBe("subdomains");
    expect(c.scope.externalDepth).toBe(0);
    expect(c.scope.allowedPaths).toEqual([]);
  });

  it("mirror of a section is limited to the start directory", () => {
    expect(resolveCrawlConfig({ startUrls: U, mode: "mirror", section: true }).scope.allowedPaths).toEqual(["/docs"]);
    expect(resolveCrawlConfig({ startUrls: ["https://x.test/a/b/"], mode: "mirror", section: true }).scope.allowedPaths).toEqual(["/a/b"]);
    expect(resolveCrawlConfig({ startUrls: ["https://x.test/page"], mode: "mirror", section: true }).scope.allowedPaths).toEqual(["/"]);
  });

  it("explore keeps the profile's link rules", () => {
    const c = resolveCrawlConfig({ startUrls: U, mode: "explore", profile: "focused" });
    expect(c.links.regions).toEqual(["content", "heading"]);
  });

  it("applies overrides on top of a preset", () => {
    const c = resolveCrawlConfig({
      startUrls: U, mode: "explore", profile: "balanced",
      overrides: { limits: { maxPages: 7 }, scope: { maxDepth: 1 }, politeness: { minDelayMs: 10 }, links: { weights: { region: { nav: 99 } }, regions: ["content"] } },
    });
    expect(c.limits.maxPages).toBe(7);
    expect(c.limits.maxBytes).toBe(PROFILES.balanced.standard.maxBytes);
    expect(c.scope.maxDepth).toBe(1);
    expect(c.politeness.minDelayMs).toBe(10);
    expect(c.links.weights.region.nav).toBe(99);
    expect(c.links.weights.region.content).toBe(85);
    expect(c.links.regions).toEqual(["content"]);
  });

  it("custom needs limits and starts from balanced", () => {
    expect(() => resolveCrawlConfig({ startUrls: U, mode: "explore", profile: "custom" })).toThrow(CrawlConfigError);
    const c = resolveCrawlConfig({ startUrls: U, mode: "explore", profile: "custom", overrides: { limits: { maxPages: 30 } } });
    expect(c.profile).toBe("custom");
    expect(c.limits.maxPages).toBe(30);
    expect(c.scope.maxDepth).toBe(PROFILES.balanced.standard.maxDepth);
  });
});

describe("hard ceilings are refused with field messages", () => {
  const issues = (over: Parameters<typeof resolveCrawlConfig>[0]["overrides"], resource: ResourceProfile = "pi-lite", mode: "explore" | "mirror" = "mirror") => {
    try {
      resolveCrawlConfig({ startUrls: U, mode, profile: "custom", resource, overrides: { limits: {}, ...over } });
    } catch (e) {
      return (e as CrawlConfigError).issues;
    }
    return [];
  };

  it("pages", () => {
    const i = issues({ limits: { maxPages: HARD_CEILINGS["pi-lite"].maxPages + 1 } });
    expect(i).toEqual([{ path: "limits.maxPages", message: expect.stringContaining("cannot be more than 10,000") }]);
  });
  it("depth", () => expect(issues({ scope: { maxDepth: 11 } }).map((x) => x.path)).toEqual(["scope.maxDepth"]));
  it("bytes", () => expect(issues({ limits: { maxBytes: 3 * 1024 ** 3 } }).map((x) => x.path)).toEqual(["limits.maxBytes"]));
  it("duration", () => expect(issues({ limits: { maxDurationMs: 25 * 3_600_000 } }).map((x) => x.path)).toEqual(["limits.maxDurationMs"]));
  it("external depth", () => expect(issues({ scope: { externalDepth: 3 } }, "pi-lite", "explore").map((x) => x.path)).toEqual(["scope.externalDepth"]));
  it("the same value passes on standard", () => expect(issues({ limits: { maxPages: 20_000 } }, "standard")).toEqual([]));
  it("reports every problem at once", () => {
    expect(issues({ limits: { maxPages: 99_999, maxBytes: 99 * 1024 ** 3 }, scope: { maxDepth: 99 } }).map((x) => x.path).sort()).toEqual(["limits.maxBytes", "limits.maxPages", "scope.maxDepth"]);
  });
  it("a mirror cannot be given more than the ceilings even with the preset", () => {
    expect(issues({ limits: { maxPages: 0 } }).map((x) => x.path)).toEqual(["limits.maxPages"]);
  });
  it("bad start URLs", () => {
    const e = (urls: string[]) => { try { resolveCrawlConfig({ startUrls: urls, mode: "explore" }); } catch (x) { return (x as CrawlConfigError).issues.map((i) => i.path); } return []; };
    expect(e([])).toEqual(["startUrls"]);
    expect(e(["ftp://x.test/"])).toEqual(["startUrls.0"]);
    expect(e(["not a url"])).toEqual(["startUrls.0"]);
    expect(e(["https://u:p@x.test/"])).toEqual(["startUrls.0"]);
  });
  it("allowlist policy needs parameters", () => {
    try {
      resolveCrawlConfig({ startUrls: U, mode: "explore", overrides: { query: { policy: "allowlist" } } });
      expect.unreachable();
    } catch (e) {
      expect((e as CrawlConfigError).issues[0]!.path).toBe("query.allowParams");
    }
  });
});

describe("type check of profile names", () => {
  it("accepts every documented profile name", () => {
    const all: ProfileName[] = ["focused", "balanced", "comprehensive", "custom"];
    expect(all).toHaveLength(4);
  });
});
