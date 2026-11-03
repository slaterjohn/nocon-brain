// Traceability (H-12). Run: pnpm traceability          rewrites docs/traceability.md and fails when a requirement has no evidence
//                        pnpm traceability --check    also fails when docs/traceability.md is out of date (CI and the unit test use this)
//
// Requirements are the IDs in docs/implementation-plan.md: tasks (F-, A-, C-, S-, O-, T-, D-, Z-, H-), performance targets (PT-) and the 24
// acceptance criteria, plus the hardening backlog (HB-). Evidence for a task is every test file that names its ID, every source file that
// names its ID, and whatever docs/traceability-map.json adds. A task that is not Post-v1 and has no test fails the run unless the map
// gives a reason for exempting it. Every path in the map and in docs/acceptance.md must exist.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const check = process.argv.includes("--check");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));
const problems = [];
const bad = (m) => problems.push(m);

// ---- the requirements ----
const plan = read("docs/implementation-plan.md");
const tasks = [...plan.matchAll(/^\| ([A-Z]-\d{2}) \| (.*) \| (MVP|v1|Post-v1)[^|]* \|$/gm)].map((m) => ({ id: m[1], text: m[2].split(" | ")[0].replace(/\*\*/g, "").replace(/`/g, "").slice(0, 110), scope: m[3] }));
const pts = [...plan.matchAll(/^\| (PT-\d{2}) \| ([^|]*) \|/gm)].map((m) => ({ id: m[1], text: m[2].trim() }));
const hbs = [...read("docs/hardening-backlog.md").matchAll(/^\| (HB-\d+) \|(.*)\| ([^|]*) \|$/gm)].map((m) => ({ id: m[1], row: m[2], status: m[3].replace(/\*\*/g, "").trim() }));
if (tasks.length < 100) bad(`only ${tasks.length} tasks parsed from docs/implementation-plan.md; has the table format changed?`);

// ---- what the repository says ----
const SKIP = new Set(["node_modules", "dist", ".next", ".next-e2e", "test-results", "bench-results", "sbom", ".git"]);
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|sh|yml|sql)$/.test(p)) out.push(p);
  }
  return out;
};
const files = ["tests", "apps", "packages", "scripts", "docker"].flatMap((d) => walk(d)).concat(["compose.yml"]);
const isTest = (f) => /(^|\/)(tests?)\//.test(f) || /\.(test|spec)\.[tj]sx?$/.test(f);
const tags = {};
for (const f of files) {
  if (f === "scripts/traceability.mjs") continue;
  for (const m of new Set(read(f).match(/\b(?:[A-Z]-\d{2}|HB-\d+)\b/g) ?? [])) {
    (tags[m] ??= { tests: new Set(), code: new Set() })[isTest(f) ? "tests" : "code"].add(f);
  }
}
const { map, exempt } = JSON.parse(read("docs/traceability-map.json"));
const ids = new Set([...tasks.map((t) => t.id), ...hbs.map((h) => h.id)]);
for (const [id, ev] of Object.entries(map)) {
  if (!ids.has(id)) bad(`traceability-map.json names ${id}, which is not a requirement`);
  for (const p of [...(ev.tests ?? []), ...(ev.code ?? [])]) if (!exists(p)) bad(`traceability-map.json: ${id} names ${p}, which does not exist`);
}
for (const id of Object.keys(exempt)) if (!ids.has(id)) bad(`traceability-map.json exempts ${id}, which is not a requirement`);

const evidence = (id) => {
  const t = new Set([...(tags[id]?.tests ?? []), ...(map[id]?.tests ?? [])]);
  const c = new Set([...(tags[id]?.code ?? []), ...(map[id]?.code ?? [])]);
  return { tests: [...t].sort(), code: [...c].sort() };
};
const short = (list, n) => (list.length ? list.slice(0, n).map((p) => `\`${p}\``).join(", ") + (list.length > n ? ` (+${list.length - n})` : "") : "none");

// ---- tasks ----
const rows = [];
const count = { covered: 0, exempt: 0, deferred: 0, missing: 0 };
for (const t of tasks) {
  const ev = evidence(t.id);
  let status;
  if (t.scope === "Post-v1") { status = "deferred (Post-v1)"; count.deferred++; }
  else if (ev.tests.length) { status = "tested"; count.covered++; }
  else if (exempt[t.id]) { status = "evidence only"; count.exempt++; }
  else { status = "NO TEST"; count.missing++; bad(`${t.id} (${t.scope}) has no test that names it and no exemption: add a test tag or an entry in docs/traceability-map.json`); }
  rows.push(`| ${t.id} | ${t.text.replace(/\|/g, "/")} | ${t.scope} | ${status} | ${ev.tests.length} | ${short(ev.tests, 3)} | ${short(ev.code, 2)} |`);
}

// ---- performance targets ----
const bench = read("docs/benchmarks.md");
const ptRows = pts.map((p) => {
  const line = bench.split("\n").find((l) => l.includes(`${p.id}`)) ?? "";
  if (!line) bad(`${p.id} is not in docs/benchmarks.md: give it a measured value or "not measured" with a reason`);
  const state = /not measured/i.test(line) ? "not measured" : /\bmiss\b/i.test(line) ? "measured, missed" : line ? "measured" : "MISSING";
  return `| ${p.id} | ${p.text.replace(/\|/g, "/")} | ${state} |`;
});

// ---- acceptance criteria ----
const acc = exists("docs/acceptance.md") ? read("docs/acceptance.md") : "";
if (!acc) bad("docs/acceptance.md is missing");
const accRows = [];
for (let n = 1; n <= 24; n++) {
  const line = acc.split("\n").find((l) => new RegExp(`^\\| ${n} \\|`).test(l));
  if (!line) { bad(`docs/acceptance.md has no row for criterion ${n}`); continue; }
  const cells = line.split("|").map((c) => c.trim());
  const status = (cells[3] ?? "").replace(/\*\*/g, "");
  if (!/^(Met|Partly met|Not met)$/.test(status)) bad(`criterion ${n}: status "${status}" must be Met, Partly met or Not met`);
  const paths = [...line.matchAll(/`([A-Za-z0-9_./@-]+\.[a-z0-9]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*)`/g)].map((m) => m[1]).filter((p) => p.includes("/"));
  for (const p of paths) if (!exists(p.replace(/#.*$/, ""))) bad(`docs/acceptance.md criterion ${n} names ${p}, which does not exist`);
  accRows.push({ n, status, evidencePaths: paths.length });
}
const accCount = (s) => accRows.filter((r) => r.status === s).length;

// ---- hardening backlog ----
const hbOut = hbs.map((h) => {
  const ev = evidence(h.id);
  const named = [...h.row.matchAll(/`((?:tests|apps|packages|scripts|docs)\/[A-Za-z0-9_./-]+)`/g)].map((m) => m[1].replace(/[.,;:]+$/, ""));
  for (const p of named) if (!exists(p)) bad(`${h.id} names ${p}, which does not exist`);
  return `| ${h.id} | ${h.status.length > 60 ? h.status.slice(0, 57) + "..." : h.status} | ${ev.tests.length + named.length} |`;
});

// ---- write ----
const out = `# Traceability

Generated by \`pnpm traceability\` from [implementation-plan.md](implementation-plan.md), [hardening-backlog.md](hardening-backlog.md), [benchmarks.md](benchmarks.md), [acceptance.md](acceptance.md) and [traceability-map.json](traceability-map.json). Do not edit by hand; edit the sources and run the script again. The unit test \`scripts/test/traceability.test.ts\` fails when this file is out of date or a requirement has no evidence.

How evidence is found: a test file counts for a task when it names the task ID (in a title or a comment), or when \`traceability-map.json\` lists it. Source files count the same way. A task that is not Post-v1 needs at least one test, or an entry under \`exempt\` in the map that says why none is possible.

## Summary

| | Count |
|---|---|
| Tasks in the plan | ${tasks.length} |
| With a test | ${count.covered} |
| Evidence only (exempt, with a reason) | ${count.exempt} |
| Deferred (Post-v1) | ${count.deferred} |
| Without evidence | ${count.missing} |
| Performance targets | ${pts.length} |
| Acceptance criteria | 24 (${accCount("Met")} met, ${accCount("Partly met")} partly met, ${accCount("Not met")} not met) |
| Hardening backlog items | ${hbs.length} |

## Tasks

| ID | Task | Scope | Status | Tests | Test files | Code |
|---|---|---|---|---|---|---|
${rows.join("\n")}

## Performance targets

| ID | Metric | State in benchmarks.md |
|---|---|---|
${ptRows.join("\n")}

## Hardening backlog

| ID | Status | Files named |
|---|---|---|
${hbOut.join("\n")}
`;
const file = path.join(root, "docs/traceability.md");
if (check) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (cur !== out) bad("docs/traceability.md is out of date: run pnpm traceability");
} else {
  fs.writeFileSync(file, out);
}
if (problems.length) {
  console.error(`traceability: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`traceability ok: ${tasks.length} tasks (${count.covered} tested, ${count.exempt} evidence only, ${count.deferred} deferred), ${pts.length} performance targets, 24 acceptance criteria, ${hbs.length} backlog items`);
