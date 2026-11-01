#!/usr/bin/env node
// Fails when a dependency licence is incompatible with AGPL-3.0 (task F-01).
// Input: the output of `pnpm licenses list --json` (read from `pnpm` or from a file given as argv[2]).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Permissive, LGPL, GPL-2.0-or-later, GPL-3.0 and AGPL licences can be combined into an AGPL-3.0 work. */
export const ALLOWED = new Set([
  "MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "Zlib", "BlueOak-1.0.0", "Unlicense",
  "CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "Python-2.0", "WTFPL", "MPL-2.0", "Artistic-2.0",
  "LGPL-2.0-only", "LGPL-2.0-or-later", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later",
  "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later",
]);

/** Aliases for old or loose SPDX spellings. */
const ALIASES = new Map([
  ["LGPL-2.1", "LGPL-2.1-only"], ["LGPL-3.0", "LGPL-3.0-only"], ["GPL-3.0", "GPL-3.0-only"], ["GPL-3.0+", "GPL-3.0-or-later"],
  ["GPL-2.0+", "GPL-2.0-or-later"], ["AGPL-3.0", "AGPL-3.0-only"], ["Apache 2.0", "Apache-2.0"], ["BSD", "BSD-3-Clause"],
]);

/** Named so the failure message says why. */
export const FLAGGED = [
  [/^BUSL/i, "Business Source License is not open source"],
  [/^SSPL/i, "SSPL is not compatible with AGPL-3.0"],
  [/proprietary|commercial|^SEE LICEN[CS]E/i, "proprietary or unspecified licence terms"],
  [/^(UNKNOWN|UNLICENSED|NONE|)$/i, "unknown licence"],
  [/^GPL-2\.0(-only)?$/i, "GPL-2.0-only cannot be combined with AGPL-3.0"],
  [/^(CC-BY-NC|CC-BY-ND)/i, "non-commercial or no-derivatives terms"],
];

function normalise(id) {
  const t = id.trim();
  return ALIASES.get(t) ?? t;
}

/** Evaluates an SPDX expression: OR passes if any side passes, AND needs all sides. Returns {ok, reason}. */
export function checkExpression(expr) {
  const text = String(expr ?? "").trim();
  const stripped = text.replace(/^\((.*)\)$/, "$1");
  if (/\sOR\s/i.test(stripped)) {
    const parts = stripped.split(/\s+OR\s+/i).map(checkExpression);
    return parts.find((p) => p.ok) ?? parts[0];
  }
  if (/\sAND\s/i.test(stripped)) {
    const parts = stripped.split(/\s+AND\s+/i).map(checkExpression);
    return parts.find((p) => !p.ok) ?? { ok: true };
  }
  const id = normalise(stripped.replace(/^\(|\)$/g, ""));
  for (const [re, reason] of FLAGGED) if (re.test(id)) return { ok: false, reason };
  if (ALLOWED.has(id)) return { ok: true };
  return { ok: false, reason: `licence "${id}" is not on the allowlist` };
}

/** @param {Record<string, {name:string, versions?:string[]}[]>} report pnpm licenses list --json */
export function auditLicences(report) {
  const problems = [];
  let packages = 0;
  for (const [licence, pkgs] of Object.entries(report)) {
    const res = checkExpression(licence);
    for (const p of pkgs) {
      packages++;
      if (!res.ok) problems.push({ name: p.name, versions: p.versions ?? [], licence, reason: res.reason });
    }
  }
  return { packages, problems };
}

function main() {
  const file = process.argv[2];
  const raw = file ? fs.readFileSync(file, "utf8") : execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const { packages, problems } = auditLicences(JSON.parse(raw));
  if (problems.length > 0) {
    console.error(`Licence audit failed: ${problems.length} of ${packages} packages are not compatible with AGPL-3.0.`);
    for (const p of problems) console.error(`  ${p.name}@${p.versions.join(",")}: ${p.licence} (${p.reason})`);
    process.exit(1);
  }
  console.log(`Licence audit passed: ${packages} packages, all compatible with AGPL-3.0.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
