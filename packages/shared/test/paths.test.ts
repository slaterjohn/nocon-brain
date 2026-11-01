import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathSafetyError, isUnderAllowedRoots, resolveInside, safeSegment } from "../src/index.js";

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ncb-paths-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "escape"));
  fs.symlinkSync(path.join(root, "sub"), path.join(root, "inside-link"));
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("resolveInside", () => {
  it("resolves a normal relative path", () => {
    expect(resolveInside(root, "sub/file.txt")).toBe(path.join(root, "sub", "file.txt"));
  });

  it("allows a target that does not exist yet", () => {
    expect(resolveInside(root, "new/deep/file")).toBe(path.join(root, "new", "deep", "file"));
  });

  it.each(["../x", "a/../../x", "..", "sub/../../outside", "..\\x"])("rejects traversal %s", (rel) => {
    expect(() => resolveInside(root, rel)).toThrow(PathSafetyError);
  });

  it.each(["/etc/passwd", "C:\\Windows", "c:/x"])("rejects absolute %s", (rel) => {
    expect(() => resolveInside(root, rel)).toThrow(PathSafetyError);
  });

  it("rejects NUL and empty", () => {
    expect(() => resolveInside(root, "a\0b")).toThrow(PathSafetyError);
    expect(() => resolveInside(root, "")).toThrow(PathSafetyError);
  });

  it("rejects the root itself unless allowRoot", () => {
    expect(() => resolveInside(root, ".")).toThrow(/root itself/);
    expect(() => resolveInside(root, "sub/..")).toThrow(/root itself/);
    expect(resolveInside(root, ".", { allowRoot: true })).toBe(root);
  });

  it("rejects a symlink that escapes the root", () => {
    expect(() => resolveInside(root, "escape")).toThrow(/Symlink escapes/);
    expect(() => resolveInside(root, "escape/file.txt")).toThrow(/Symlink escapes/);
  });

  it("checks the deepest existing ancestor for a missing target", () => {
    expect(() => resolveInside(root, "escape/new/deeper/file")).toThrow(/Symlink escapes/);
  });

  it("allows a symlink that stays inside the root", () => {
    expect(resolveInside(root, "inside-link/f")).toBe(path.join(root, "inside-link", "f"));
  });

  it("rejects a symlink resolving to the root when allowRoot is off", () => {
    fs.symlinkSync(root, path.join(root, "self"));
    expect(() => resolveInside(root, "self")).toThrow(PathSafetyError);
    expect(resolveInside(root, "self", { allowRoot: true })).toBe(path.join(root, "self"));
  });
});

describe("helpers", () => {
  it("isUnderAllowedRoots", () => {
    expect(isUnderAllowedRoots("/volumes/default", ["/volumes"])).toBe(true);
    expect(isUnderAllowedRoots("/volumes", ["/volumes"])).toBe(true);
    expect(isUnderAllowedRoots("/volumes-evil/x", ["/volumes"])).toBe(false);
    expect(isUnderAllowedRoots("/volumes/../etc", ["/volumes"])).toBe(false);
  });

  it("safeSegment", () => {
    expect(safeSegment("../a b")).toBe("__a_b");
    expect(safeSegment("")).toBe("_");
  });
});
