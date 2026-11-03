import { describe, expect, it } from "vitest";
import { buildSbom, parseLock, purlOf, splitId, validateSbom } from "../sbom.mjs";

const B64 = Buffer.alloc(64, 7).toString("base64");
const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left-pad:
        specifier: ^1.0.0
        version: 1.3.0
      '@scope/tool':
        specifier: ^2.0.0
        version: 2.1.0(peer-dep@3.0.0)
    devDependencies:
      vitest:
        specifier: ^5.0.0
        version: 5.0.5
      '@ncb/shared':
        specifier: workspace:*
        version: link:packages/shared

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-${B64}}
    engines: {node: '>=10'}

  '@scope/tool@2.1.0':
    resolution: {integrity: sha512-${B64}, tarball: https://example.test/tool-2.1.0.tgz}
    peerDependencies:
      peer-dep: '>=3'

  vitest@5.0.5:
    resolution: {integrity: sha512-${B64}}

  tiny-dev@1.0.0:
    resolution: {integrity: sha512-${B64}}
    cpu: [x64]
    os: [darwin]

  peer-dep@3.0.0:
    resolution: {integrity: sha512-${B64}}

snapshots:

  left-pad@1.3.0: {}

  '@scope/tool@2.1.0(peer-dep@3.0.0)':
    dependencies:
      peer-dep: 3.0.0
      left-pad: 1.3.0

  vitest@5.0.5:
    dependencies:
      tiny-dev: 1.0.0

  tiny-dev@1.0.0:
    optional: true

  peer-dep@3.0.0: {}
`;

describe("scripts/sbom.mjs", () => {
  const lock = parseLock(LOCK);

  it("reads the lockfile subset pnpm writes: quoted keys, flow maps, lists and nested maps", () => {
    expect(Object.keys(lock.packages)).toContain("@scope/tool@2.1.0");
    expect(lock.packages["@scope/tool@2.1.0"].resolution.tarball).toBe("https://example.test/tool-2.1.0.tgz");
    expect(lock.packages["tiny-dev@1.0.0"].cpu).toEqual(["x64"]);
    expect(lock.importers["."].dependencies["@scope/tool"].version).toBe("2.1.0(peer-dep@3.0.0)");
    expect(lock.snapshots["@scope/tool@2.1.0(peer-dep@3.0.0)"].dependencies["left-pad"]).toBe("1.3.0");
  });

  it("splits ids and builds package URLs", () => {
    expect(splitId("@scope/tool@2.1.0(peer-dep@3.0.0)")).toEqual({ name: "@scope/tool", version: "2.1.0" });
    expect(splitId("left-pad@1.3.0")).toEqual({ name: "left-pad", version: "1.3.0" });
    expect(purlOf("@scope/tool", "2.1.0")).toBe("pkg:npm/%40scope/tool@2.1.0");
  });

  it("makes a valid CycloneDX document with licences, hashes, scopes and the dependency graph", () => {
    const bom = buildSbom(lock, {
      licences: new Map([["left-pad", "MIT"], ["@scope/tool", "(MIT OR Apache-2.0)"]]),
      root: { name: "nocon-brain", version: "0.1.0", licence: "AGPL-3.0-only" }, now: 0,
    });
    expect(validateSbom(bom)).toEqual([]);
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.5");
    expect(bom.metadata.timestamp).toBe("1970-01-01T00:00:00.000Z");
    const byName = Object.fromEntries(bom.components.map((c: any) => [`${c.group ? c.group + "/" : ""}${c.name}`, c]));
    expect(Object.keys(byName).sort()).toEqual(["@scope/tool", "left-pad", "peer-dep", "tiny-dev", "vitest"]);
    expect(byName["left-pad"].licenses).toEqual([{ license: { id: "MIT" } }]);
    expect(byName["@scope/tool"].licenses).toEqual([{ expression: "(MIT OR Apache-2.0)" }]);
    expect(byName["left-pad"].hashes[0]).toEqual({ alg: "SHA-512", content: "07".repeat(64) });
    expect(byName["left-pad"].scope).toBe("required");
    expect(byName["peer-dep"].scope).toBe("required"); // reached from a production dependency
    expect(byName["vitest"].scope).toBe("excluded");
    expect(byName["tiny-dev"].scope).toBe("excluded");
    const dep = (ref: string) => bom.dependencies.find((d: any) => d.ref === ref).dependsOn;
    expect(dep("pkg:npm/%40scope/tool@2.1.0").sort()).toEqual(["pkg:npm/left-pad@1.3.0", "pkg:npm/peer-dep@3.0.0"]);
    // workspace links are not components, and the root depends on every direct dependency
    expect(JSON.stringify(bom.components)).not.toContain("@ncb/shared");
    expect(dep(bom.metadata.component["bom-ref"])).toContain("pkg:npm/vitest@5.0.5");
  });

  it("--prod leaves out everything only development tooling reaches", () => {
    const bom = buildSbom(lock, { prodOnly: true, root: { name: "x", version: "1.0.0", licence: "AGPL-3.0-only" } });
    expect(validateSbom(bom)).toEqual([]);
    expect(bom.components.map((c: any) => c.name).sort()).toEqual(["left-pad", "peer-dep", "tool"]);
  });

  it("the validator catches a broken document", () => {
    const bom = buildSbom(lock, {});
    bom.components.push({ ...bom.components[0] });
    bom.dependencies[0].dependsOn.push("pkg:npm/ghost@0.0.0");
    const problems = validateSbom(bom);
    expect(problems.some((p: string) => /duplicate bom-ref/.test(p))).toBe(true);
    expect(problems.some((p: string) => /unknown/.test(p))).toBe(true);
  });
});
