import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// H-12: every requirement has evidence, docs/traceability.md is current, and docs/acceptance.md names real files.
const root = path.resolve(import.meta.dirname, "../..");

describe("traceability", () => {
  it("passes `node scripts/traceability.mjs --check`", () => {
    const out = execFileSync(process.execPath, ["scripts/traceability.mjs", "--check"], { cwd: root, encoding: "utf8" });
    expect(out).toMatch(/traceability ok/);
  });
});
