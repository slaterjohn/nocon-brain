import { describe, expect, it } from "vitest";
import { CEILINGS, PRESETS } from "../src/sources/limits.js";
import { defaultRetention, resolveConfig, sourceInputSchema, sourcePatchSchema } from "../src/sources/schema.js";
import { parseOrThrow, RequestValidationError } from "../src/lib/zod.js";
import { COLLECTION_ICONS, isIcon } from "../src/collections/icons.js";
import { ruleSchema, ruleToSql } from "../src/collections/rules.js";

const base = { name: "Docs", type: "website", startUrl: "https://example.com/docs/" };

function fieldsOf(schema: ReturnType<typeof sourceInputSchema>, input: unknown) {
  try {
    parseOrThrow(schema, input);
  } catch (e) {
    if (e instanceof RequestValidationError) return e.fields;
    throw e;
  }
  return [];
}

describe("C-06 source validation", () => {
  it("accepts a minimal website source and fills in defaults", () => {
    const v = parseOrThrow(sourceInputSchema("standard"), base);
    expect(v).toMatchObject({ profile: "balanced", priority: 3, enabled: true, discoveryEnabled: false, adapter: "http" });
  });

  it("accepts priority as P1 to P4 or 1 to 4 and rejects others", () => {
    expect((parseOrThrow(sourceInputSchema("standard"), { ...base, priority: "P2" }) as { priority: number }).priority).toBe(2);
    expect((parseOrThrow(sourceInputSchema("standard"), { ...base, priority: 4 }) as { priority: number }).priority).toBe(4);
    expect(fieldsOf(sourceInputSchema("standard"), { ...base, priority: "P5" }).map((f) => f.path)).toContain("priority");
  });

  it.each([
    ["saved_search", /Saved-search sources arrive with online search/],
    ["knowledge_package", /Knowledge-package sources arrive with ZIM support/],
  ])("rejects the later type %s with a message saying why", (type, msg) => {
    const f = fieldsOf(sourceInputSchema("standard"), { ...base, type });
    expect(f.find((x) => x.path === "type")?.message).toMatch(msg);
  });

  it("accepts imported_documents without an address and refuses one", () => {
    expect(fieldsOf(sourceInputSchema("standard"), { name: "Papers", type: "imported_documents" })).toEqual([]);
    expect(fieldsOf(sourceInputSchema("standard"), { name: "Papers", type: "imported_documents", startUrl: "https://x.test/" }).map((f) => f.path)).toEqual(["startUrl"]);
  });

  it("needs a start address for web types and refuses odd addresses", () => {
    expect(fieldsOf(sourceInputSchema("standard"), { name: "x", type: "website" }).map((f) => f.path)).toEqual(["startUrl"]);
    for (const bad of ["ftp://x.test/", "javascript:alert(1)", "https://user:pw@x.test/", "not a url"]) {
      expect(fieldsOf(sourceInputSchema("standard"), { ...base, startUrl: bad }).map((f) => f.path), bad).toEqual(["startUrl"]);
    }
  });

  it("refuses non-http adapters until they exist", () => {
    expect(fieldsOf(sourceInputSchema("standard"), { ...base, adapter: "wikipedia" }).map((f) => f.path)).toContain("adapter");
  });

  it("gives one field message per bad value", () => {
    const f = fieldsOf(sourceInputSchema("standard"), { name: "", type: "website", startUrl: "https://x.test/", config: { depth: -1, maxPages: 0, concurrency: "many" } });
    expect(f.map((x) => x.path).sort()).toEqual(["config.concurrency", "config.depth", "config.maxPages", "name"]);
  });

  it("requires an allowlist when the query policy is allowlist", () => {
    expect(fieldsOf(sourceInputSchema("standard"), { ...base, config: { queryParamPolicy: "allowlist" } }).map((x) => x.path)).toEqual(["config.queryParamAllowlist"]);
  });

  describe.each(["pi-lite", "standard"] as const)("hard ceilings on the %s profile", (profile) => {
    const c = CEILINGS[profile];
    it("accepts values at the ceiling", () => {
      const cfg = { depth: c.depth, maxPages: c.maxPages, maxBytes: c.maxBytes, maxDurationSeconds: c.maxDurationSeconds, concurrency: c.concurrency, perDomainDelayMs: c.minPerDomainDelayMs, retries: c.retries, externalDepth: c.externalDepth };
      expect(fieldsOf(sourceInputSchema(profile), { ...base, config: cfg })).toEqual([]);
    });
    it.each(["depth", "maxPages", "maxBytes", "maxDurationSeconds", "concurrency", "retries", "externalDepth"] as const)("refuses %s one above the ceiling", (key) => {
      const f = fieldsOf(sourceInputSchema(profile), { ...base, config: { [key]: c[key] + 1 } });
      expect(f.map((x) => x.path)).toEqual([`config.${key}`]);
      expect(f[0]!.message).toContain(`on the ${profile} profile`);
    });
    it("refuses a request delay below the politeness floor", () => {
      const f = fieldsOf(sourceInputSchema(profile), { ...base, config: { perDomainDelayMs: c.minPerDomainDelayMs - 1 } });
      expect(f.map((x) => x.path)).toEqual(["config.perDomainDelayMs"]);
    });
  });

  it("the Pi profile is stricter than the standard one on every limit", () => {
    for (const k of ["depth", "maxPages", "maxBytes", "maxDurationSeconds", "concurrency"] as const) expect(CEILINGS["pi-lite"][k]).toBeLessThan(CEILINGS.standard[k]);
    expect(fieldsOf(sourceInputSchema("pi-lite"), { ...base, config: { maxPages: 6000 } })).toHaveLength(1);
    expect(fieldsOf(sourceInputSchema("standard"), { ...base, config: { maxPages: 6000 } })).toEqual([]);
  });

  it("a patch is checked against the ceilings too", () => {
    expect(() => parseOrThrow(sourcePatchSchema("pi-lite"), { config: { maxPages: 99999 } })).toThrow(RequestValidationError);
    expect(parseOrThrow(sourcePatchSchema("pi-lite"), { name: "New" })).toEqual({ name: "New" });
  });

  it("presets are clamped to the ceilings, never raised", () => {
    const pi = resolveConfig({}, "website", "comprehensive", "pi-lite");
    expect(pi.maxPages).toBe(Math.min(PRESETS.comprehensive.maxPages, CEILINGS["pi-lite"].maxPages));
    expect(pi.maxBytes).toBe(Math.min(PRESETS.comprehensive.maxBytes, CEILINGS["pi-lite"].maxBytes));
    expect(pi.concurrency).toBeLessThanOrEqual(CEILINGS["pi-lite"].concurrency);
    expect(resolveConfig({}, "website", "focused", "standard").depth).toBe(PRESETS.focused.depth);
  });

  it("types fix what must be true for them", () => {
    const single = resolveConfig({ depth: 5, maxPages: 99 }, "single_page", "balanced", "standard");
    expect(single).toMatchObject({ depth: 0, maxPages: 1, includeExternal: false });
    expect(resolveConfig({}, "feed", "balanced", "standard").depth).toBe(0);
    expect(resolveConfig({}, "linked_collection", "balanced", "standard")).toMatchObject({ includeExternal: true, externalDepth: 1 });
    expect(resolveConfig({}, "section", "balanced", "standard", "https://x.test/docs/guide/page.html").allowedPaths).toEqual(["/docs/guide/**"]);
    expect(resolveConfig({ allowedPaths: ["/only/**"] }, "section", "balanced", "standard", "https://x.test/docs/a").allowedPaths).toEqual(["/only/**"]);
  });

  it("retention follows versioning by default", () => {
    expect(defaultRetention(resolveConfig({ versioning: { mode: "all" } }, "website", "balanced", "standard"))).toEqual({ mode: "all" });
    expect(defaultRetention(resolveConfig({}, "website", "balanced", "standard"))).toEqual({ mode: "latest", count: 1 });
  });
});

describe("C-13 collection icons and rules", () => {
  it("icons come from a fixed list of lucide names", () => {
    expect(COLLECTION_ICONS.length).toBeGreaterThan(30);
    expect(new Set(COLLECTION_ICONS).size).toBe(COLLECTION_ICONS.length);
    expect(COLLECTION_ICONS.every((n) => /^[a-z][a-z0-9-]*$/.test(n))).toBe(true);
    expect(isIcon("star")).toBe(true);
    expect(isIcon("<script>")).toBe(false);
  });

  it("rules validate and compile to parameterised SQL", () => {
    expect(() => ruleSchema.parse({ conditions: [] })).toThrow();
    expect(() => ruleSchema.parse({ conditions: [{ field: "domain", value: "a b" }] })).toThrow();
    const rule = ruleSchema.parse({ match: "any", conditions: [{ field: "domain", value: "Example.com" }, { field: "title", value: "50%_off" }, { field: "source", value: "src_X" }] });
    const q = ruleToSql(rule);
    expect(q.sql).toContain(" OR ");
    expect(q.sql).not.toContain("example.com");
    expect(q.params).toEqual(["example.com", "%.example.com", "%50\\%\\_off%", "src_X"]);
  });
});
