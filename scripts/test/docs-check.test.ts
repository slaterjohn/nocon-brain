import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// H-07: settings, routes, links and the docs index agree with the code.
const root = path.resolve(import.meta.dirname, "../..");

describe("documentation", () => {
  it("passes `node scripts/docs-check.mjs`", () => {
    const out = execFileSync(process.execPath, ["scripts/docs-check.mjs"], { cwd: root, encoding: "utf8" });
    expect(out).toMatch(/docs:check ok/);
  });
});
