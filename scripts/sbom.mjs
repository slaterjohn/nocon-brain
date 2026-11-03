#!/usr/bin/env node
// Software bill of materials (task H-03): a CycloneDX 1.5 JSON document built from pnpm-lock.yaml.
//
//   pnpm sbom                  writes sbom/nocon-brain.cdx.json (gitignored: generated, never committed)
//   pnpm sbom --prod           production dependencies only (what ships in the images)
//   pnpm sbom --out FILE       another path
//   pnpm sbom --no-licences    skip the `pnpm licenses list` lookup (offline, faster)
//
// No third-party tool: the lockfile is read by a small parser below, so nothing is added to the dependency tree (and so nothing new for the
// licence audit). Licences come from `pnpm licenses list --json`, the same source as `pnpm licence-audit`. Every component carries its
// package URL, its integrity hash (SHA-512 from the lockfile) and a scope: `required` when a production dependency reaches it, `excluded`
// when only development tooling does.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- a reader for the subset of YAML that pnpm-lock.yaml (lockfileVersion 9) uses ----------------------------------------------------

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Splits `a: b, c: [d, e]` on top-level commas. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function splitKey(s) {
  // `'quoted key': value` or `plain: value`
  if (s.startsWith("'") || s.startsWith('"')) {
    const q = s[0];
    let i = 1;
    while (i < s.length && !(s[i] === q && s[i + 1] !== q)) i += s[i] === q ? 2 : 1;
    return [unquote(s.slice(0, i + 1)), s.slice(i + 2).replace(/^:\s*/, "")];
  }
  const m = /^([^:]+?):(?:\s+(.*))?$/.exec(s);
  return m ? [m[1], m[2] ?? ""] : [s, ""];
}

function flow(s) {
  const t = s.trim();
  if (t === "{}") return {};
  if (t === "[]") return [];
  if (t.startsWith("{")) {
    const o = {};
    for (const part of splitTop(t.slice(1, -1))) {
      const [k, v] = splitKey(part.trim());
      o[k] = flow(v);
    }
    return o;
  }
  if (t.startsWith("[")) return splitTop(t.slice(1, -1)).map((x) => flow(x));
  return unquote(t);
}

/** @param {string} text @returns {any} */
export function parseLock(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const [key, rest] = splitKey(raw.trim());
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (rest === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = flow(rest);
    }
  }
  return root;
}

// ---- the bill of materials -----------------------------------------------------------------------------------------------------------

/** `@scope/name@1.2.3(peer@4)` -> { name, version }. The peer suffix is part of pnpm's snapshot key, not of the package. */
export function splitId(id) {
  const bare = id.replace(/\(.*$/, "");
  const at = bare.lastIndexOf("@");
  return { name: bare.slice(0, at), version: bare.slice(at + 1) };
}

export function purlOf(name, version) {
  const enc = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${enc}@${version}`;
}

function hexFromIntegrity(integrity) {
  const m = /^sha512-(.+)$/.exec(integrity ?? "");
  return m ? Buffer.from(m[1], "base64").toString("hex") : null;
}

/**
 * @param lock      parsed pnpm-lock.yaml
 * @param opts      { licences: Map<name, string>, prodOnly, root: { name, version, licence }, now }
 */
/** @param {any} lock @param {any} [opts] @returns {any} */
export function buildSbom(lock, opts = {}) {
  const licences = opts.licences ?? new Map();
  const rootInfo = opts.root ?? { name: "nocon-brain", version: "0.0.0", licence: "AGPL-3.0-only" };
  const packages = lock.packages ?? {};
  const snapshots = lock.snapshots ?? {};

  // dependency edges between registry packages (peer suffixes folded away)
  const edges = new Map();
  const optionalOnly = new Set();
  for (const [snapId, snap] of Object.entries(snapshots)) {
    const from = splitId(snapId);
    const key = `${from.name}@${from.version}`;
    const set = edges.get(key) ?? new Set();
    for (const [dep, ver] of Object.entries({ ...(snap.dependencies ?? {}), ...(snap.optionalDependencies ?? {}) })) {
      if (String(ver).startsWith("link:")) continue;
      const v = String(ver);
      // an alias is written `npm:real@1.0.0`
      const target = v.startsWith("npm:") ? splitId(v.slice(4)) : { name: dep, version: v.replace(/\(.*$/, "") };
      set.add(`${target.name}@${target.version}`);
    }
    edges.set(key, set);
    if (snap.optional === true) optionalOnly.add(key);
  }

  // which packages production code can reach
  const prodRoots = new Set();
  const allRoots = new Set();
  for (const imp of Object.values(lock.importers ?? {})) {
    for (const group of ["dependencies", "optionalDependencies", "devDependencies"]) {
      for (const [dep, info] of Object.entries(imp[group] ?? {})) {
        const v = String(info.version ?? "");
        if (v.startsWith("link:")) continue;
        const target = v.startsWith("npm:") ? splitId(v.slice(4)) : { name: dep, version: v.replace(/\(.*$/, "") };
        const k = `${target.name}@${target.version}`;
        allRoots.add(k);
        if (group !== "devDependencies") prodRoots.add(k);
      }
    }
  }
  const reach = (starts) => {
    const seen = new Set();
    const todo = [...starts];
    while (todo.length) {
      const k = todo.pop();
      if (seen.has(k)) continue;
      seen.add(k);
      for (const d of edges.get(k) ?? []) todo.push(d);
    }
    return seen;
  };
  const prod = reach(prodRoots);

  const components = [];
  const refOf = new Map();
  for (const [id, info] of Object.entries(packages)) {
    const { name, version } = splitId(id);
    const key = `${name}@${version}`;
    const isProd = prod.has(key);
    if (opts.prodOnly && !isProd) continue;
    const ref = purlOf(name, version);
    refOf.set(key, ref);
    const hash = hexFromIntegrity(info.resolution?.integrity);
    const lic = licences.get(name);
    const c = {
      type: "library",
      "bom-ref": ref,
      ...(name.startsWith("@") ? { group: name.split("/")[0], name: name.split("/").slice(1).join("/") } : { name }),
      version,
      scope: isProd ? (optionalOnly.has(key) ? "optional" : "required") : "excluded",
      purl: ref,
      ...(hash ? { hashes: [{ alg: "SHA-512", content: hash }] } : {}),
      ...(lic ? { licenses: [/[ ()]| OR | AND /.test(lic) ? { expression: lic } : { license: { id: lic } }] } : {}),
      ...(info.resolution?.tarball ? { externalReferences: [{ type: "distribution", url: info.resolution.tarball }] } : {}),
    };
    components.push(c);
  }
  components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));

  const rootRef = purlOf(rootInfo.name, rootInfo.version);
  const dependencies = [{ ref: rootRef, dependsOn: [...(opts.prodOnly ? prodRoots : allRoots)].map((k) => refOf.get(k)).filter(Boolean).sort() }];
  for (const [key, ref] of [...refOf.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    dependencies.push({ ref, dependsOn: [...(edges.get(key) ?? [])].map((k) => refOf.get(k)).filter(Boolean).sort() });
  }

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date(opts.now ?? Date.now()).toISOString(),
      tools: { components: [{ type: "application", name: "nocon-brain scripts/sbom.mjs" }] },
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: rootInfo.name,
        version: rootInfo.version,
        licenses: [{ license: { id: rootInfo.licence } }],
      },
    },
    components,
    dependencies,
  };
}

/** Structural checks used by the unit test and by `--check`. Returns a list of problems. */
/** @param {any} bom @returns {string[]} */
export function validateSbom(bom) {
  const problems = [];
  if (bom.bomFormat !== "CycloneDX") problems.push("bomFormat is not CycloneDX");
  if (!/^1\.\d$/.test(bom.specVersion ?? "")) problems.push("specVersion missing");
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(bom.serialNumber ?? "")) problems.push("serialNumber is not a urn:uuid");
  const refs = new Set();
  for (const c of bom.components ?? []) {
    if (!c.name || !c.version || !c.purl || !c["bom-ref"]) problems.push(`component incomplete: ${JSON.stringify(c).slice(0, 80)}`);
    if (refs.has(c["bom-ref"])) problems.push(`duplicate bom-ref ${c["bom-ref"]}`);
    refs.add(c["bom-ref"]);
    if (c.hashes?.some((h) => !/^[0-9a-f]{128}$/.test(h.content))) problems.push(`bad SHA-512 on ${c["bom-ref"]}`);
  }
  refs.add(bom.metadata?.component?.["bom-ref"]);
  for (const d of bom.dependencies ?? []) {
    if (!refs.has(d.ref)) problems.push(`dependency of unknown ref ${d.ref}`);
    for (const x of d.dependsOn) if (!refs.has(x)) problems.push(`${d.ref} depends on unknown ${x}`);
  }
  return problems;
}

// ---- command line --------------------------------------------------------------------------------------------------------------------

function licenceMap() {
  const raw = execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const map = new Map();
  for (const [licence, pkgs] of Object.entries(JSON.parse(raw))) for (const p of pkgs) map.set(p.name, licence);
  return map;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const out = args.includes("--out") ? path.resolve(args[args.indexOf("--out") + 1]) : path.join(root, "sbom", "nocon-brain.cdx.json");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = parseLock(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  let licences = new Map();
  if (!flag("--no-licences")) {
    try {
      licences = licenceMap();
    } catch (e) {
      console.warn(`Could not read licences (${String(e.message).split("\n")[0]}); continuing without them.`);
    }
  }
  const bom = buildSbom(lock, { licences, prodOnly: flag("--prod"), root: { name: pkg.name, version: pkg.version, licence: pkg.license } });
  const problems = validateSbom(bom);
  if (problems.length) {
    console.error(`SBOM is not valid:\n  ${problems.slice(0, 20).join("\n  ")}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(bom, null, 2) + "\n");
  const withLicence = bom.components.filter((c) => c.licenses).length;
  console.log(`SBOM written to ${path.relative(process.cwd(), out)}: ${bom.components.length} components (${withLicence} with a licence), CycloneDX ${bom.specVersion}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
