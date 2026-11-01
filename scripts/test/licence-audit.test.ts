import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { auditLicences, checkExpression } from "../licence-audit.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/licenses.json", import.meta.url), "utf8"));

describe("licence audit", () => {
  it("passes permissive, LGPL, GPL-3.0 and dual licences, flags the rest by name", () => {
    const { packages, problems } = auditLicences(fixture);
    expect(packages).toBe(10);
    expect(problems.map((p: { name: string }) => p.name).sort()).toEqual(["bsl-db", "gpl2-only", "mixed", "mystery", "prop", "sspl-thing"]);
    expect(problems.find((p: { name: string }) => p.name === "bsl-db")?.reason).toMatch(/Business Source/);
  });

  it("evaluates SPDX expressions", () => {
    expect(checkExpression("(MIT OR GPL-2.0-only)").ok).toBe(true);
    expect(checkExpression("(MIT AND Apache-2.0)").ok).toBe(true);
    expect(checkExpression("MIT AND BUSL-1.1").ok).toBe(false);
    expect(checkExpression("AGPL-3.0-or-later").ok).toBe(true);
    expect(checkExpression("GPL-2.0-or-later").ok).toBe(true);
    expect(checkExpression("Weird-1.0").ok).toBe(false);
    expect(checkExpression("").ok).toBe(false);
  });
});
