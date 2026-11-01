import path from "node:path";
import fs from "node:fs";

export class PathSafetyError extends Error {}

/** Validates a relative path segment list contains no traversal. Returns normalised posix path. */
export function normaliseRelative(rel: string): string {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) throw new PathSafetyError("Invalid path");
  const unixish = rel.replace(/\\/g, "/");
  if (unixish.startsWith("/") || /^[a-zA-Z]:/.test(unixish)) throw new PathSafetyError("Absolute paths are not allowed");
  const norm = path.posix.normalize(unixish);
  if (norm === ".." || norm.startsWith("../") || norm.split("/").includes("..")) throw new PathSafetyError("Path traversal");
  return norm;
}

export interface ResolveInsideOptions {
  /** Permit a result equal to the root itself (e.g. "." or ""-like paths). Default: rejected. */
  allowRoot?: boolean;
}

/**
 * Joins rel onto root and guarantees the result is strictly inside root, including after symlink
 * resolution. For a target that does not exist yet, the deepest existing ancestor is resolved and must
 * be inside the real root too. Resolving to the root itself is rejected unless `allowRoot` is set.
 */
export function resolveInside(root: string, rel: string, opts: ResolveInsideOptions = {}): string {
  const norm = normaliseRelative(rel);
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, norm);
  if (target !== absRoot && !target.startsWith(absRoot + path.sep)) throw new PathSafetyError("Path escapes root");
  if (target === absRoot && !opts.allowRoot) throw new PathSafetyError("Path resolves to the root itself");
  let realRoot: string;
  try { realRoot = fs.realpathSync(absRoot); } catch { return target; } // root missing: nothing to escape through
  // Walk up to the deepest ancestor that exists, then compare its real path with the real root.
  let probe = target;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new PathSafetyError("Symlink escapes root");
      if (real === realRoot && probe === target && !opts.allowRoot) throw new PathSafetyError("Path resolves to the root itself");
      break;
    } catch (e) {
      if (e instanceof PathSafetyError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new PathSafetyError("Path could not be verified");
      const parent = path.dirname(probe);
      if (parent === probe || probe === absRoot) break;
      probe = parent;
    }
  }
  return target;
}

/** Is `candidate` equal to or inside one of the allowed roots (lexically, after resolve)? */
export function isUnderAllowedRoots(candidate: string, roots: string[]): boolean {
  const abs = path.resolve(candidate);
  return roots.some((r) => {
    const ar = path.resolve(r);
    return abs === ar || abs.startsWith(ar + path.sep);
  });
}

/** Make a safe single path segment from an external identifier. */
export function safeSegment(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_\-.]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return s || "_";
}
