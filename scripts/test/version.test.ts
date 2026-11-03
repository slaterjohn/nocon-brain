import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// H-10: one version number. `node scripts/set-version.mjs <semver>` changes every place at once.
const root = path.resolve(import.meta.dirname, "../..");
const manifests = ["package.json", ...["apps", "packages"].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((n) => fs.existsSync(path.join(root, d, n, "package.json"))).map((n) => `${d}/${n}/package.json`))];
const versionOf = (m: string) => (JSON.parse(fs.readFileSync(path.join(root, m), "utf8")) as { version: string }).version;

describe("version", () => {
  it("is the same in the root, every app and every package, and in the server's VERSION constant", () => {
    const want = versionOf("package.json");
    expect(want).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    for (const m of manifests) expect(versionOf(m), m).toBe(want);
    expect(fs.readFileSync(path.join(root, "apps/server/src/version.ts"), "utf8")).toContain(`"${want}"`);
  });

  it("has a changelog entry for the version, or an Unreleased section for it", () => {
    const want = versionOf("package.json");
    const log = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(log.includes(`## [${want}]`) || log.includes("## [Unreleased]")).toBe(true);
  });
});
