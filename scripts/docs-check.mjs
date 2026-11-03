// Documentation checks (H-07). Run: pnpm docs:check. Exits 1 with a list when the docs and the code disagree.
//   1. Every setting in packages/shared/src/config.ts is in .env.example (or is on the short "not for operators" list below).
//   2. Every NCB_ name in .env.example and in the operator docs is a real setting: in config.ts, in compose.yml, or on the list below.
//   3. Every HTTP route registered by the server appears in docs/api.md (path, with parameter names ignored).
//   4. Every relative link in README.md, SECURITY.md and docs/**/*.md points at a file that exists.
//   5. docs/README.md mentions every top-level file in docs/.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const problems = [];
const bad = (m) => problems.push(m);

// Settings that exist in code but are deliberately not in .env.example.
const NOT_FOR_OPERATORS = new Set([
  "NODE_ENV", // set by the images
  "NCB_API_HOST", "NCB_ARCHIVE_HOST", // bind addresses inside the container; Compose publishes ports with NCB_*_BIND instead
  "NCB_API_PROXY_FROM", // fixed by compose.yml from NCB_BACKEND_SUBNET
  "NCB_RENDER_PROXY_HOST", // fixed by compose.yml from NCB_RENDER_SUBNET
  "NCB_WIKIPEDIA_ORIGIN", // replaces wikipedia.org for the test fake or a mirror
]);
// Names that are used outside config.ts (Compose, scripts, tests) and are real.
const EXTRA_REAL = new Set(["NCB_FETCH_ALLOW_PRIVATE_HOSTS", "NCB_DOCKER_TESTS", "NCB_QUALITY_REAL", "NCB_SEARCH_CORPUS", "NCB_SEARXNG_URL"]);

// ---- 1 and 2: settings ----
const config = read("packages/shared/src/config.ts");
const inConfig = new Set([...config.matchAll(/^\s{2}(NCB_[A-Z0-9_]+|NODE_ENV):/gm)].map((m) => m[1]));
const envExample = read(".env.example");
const inExample = new Set([...envExample.matchAll(/NCB_[A-Z0-9_]+/g)].map((m) => m[0]));
const compose = read("compose.yml") + read("compose.offline.yml");
const inCompose = new Set([...compose.matchAll(/NCB_[A-Z0-9_]+/g)].map((m) => m[0]));
for (const v of inConfig) if (!inExample.has(v) && !NOT_FOR_OPERATORS.has(v)) bad(`config.ts defines ${v} but .env.example does not mention it`);
for (const v of inExample) if (!inConfig.has(v) && !inCompose.has(v) && !EXTRA_REAL.has(v)) bad(`.env.example mentions ${v}, which is neither in config.ts nor compose.yml`);

const operatorDocs = ["README.md", "SECURITY.md", "docs/README.md", "docs/deployment.md", "docs/security.md", "docs/browser-support.md", "docs/accessibility.md", "docs/configuration.md",
  "docs/architecture.md", ...fs.readdirSync(path.join(root, "docs/guides")).map((f) => `docs/guides/${f}`)].filter((p) => fs.existsSync(path.join(root, p)));
for (const f of operatorDocs) {
  for (const m of new Set(read(f).match(/NCB_[A-Z0-9_]+/g) ?? [])) {
    if (m.endsWith("_")) continue; // a prefix such as NCB_
    if (!inConfig.has(m) && !inCompose.has(m) && !EXTRA_REAL.has(m)) bad(`${f} mentions ${m}, which is neither in config.ts nor compose.yml`);
  }
}

// ---- 3: routes ----
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
})("apps/server/src");
const routes = new Set();
for (const f of files) {
  const s = read(f);
  for (const m of s.matchAll(/\b(?:app|r|api)\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*"(\/[^"]+)"/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
}
const norm = (p) => p.replace(/:[A-Za-z]+/g, ":p").replace(/\{[A-Za-z]+\}/g, ":p").replace(/[.,;:)]+$/, "");
const apiDoc = read("docs/api.md");
const documented = new Set([...apiDoc.matchAll(/`?(\/(?:api|a|w|s)\/[A-Za-z0-9_\/:{}.\-]*)/g)].map((m) => norm(m[1])));
for (const r of [...routes].sort()) {
  const p = norm(r.split(" ")[1]);
  if (!p.startsWith("/api/")) continue;
  if (!documented.has(p)) bad(`docs/api.md does not mention ${r}`);
}

// ---- 4: links ----
const mdFiles = ["README.md", "SECURITY.md", "CHANGELOG.md", ...fs.readdirSync(path.join(root, "docs"), { recursive: true }).filter((f) => f.endsWith(".md") && !f.startsWith("research/")).map((f) => `docs/${f}`)];
for (const f of mdFiles) {
  if (!fs.existsSync(path.join(root, f))) continue;
  const text = read(f).replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
    const target = m[1].split("#")[0];
    if (!target) continue;
    const abs = path.resolve(root, path.dirname(f), target);
    // A link outside the repo can resolve on a developer's machine (a sibling checkout) but is broken on GitHub and in CI.
    if (path.relative(root, abs).startsWith("..")) bad(`${f} links to ${m[1]}, which is outside the repository (use a full URL)`);
    else if (!fs.existsSync(abs)) bad(`${f} links to ${m[1]}, which does not exist`);
  }
}

// ---- 5: index ----
const index = read("docs/README.md");
for (const f of fs.readdirSync(path.join(root, "docs"))) {
  if (f.endsWith(".md") && f !== "README.md" && !index.includes(f)) bad(`docs/README.md does not list docs/${f}`);
}
for (const f of fs.readdirSync(path.join(root, "docs/guides"))) if (!index.includes(f)) bad(`docs/README.md does not list docs/guides/${f}`);

if (problems.length) {
  console.error(`docs:check found ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`docs:check ok (${inConfig.size} settings, ${routes.size} routes, ${mdFiles.length} files)`);
