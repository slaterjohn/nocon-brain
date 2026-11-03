// Sets one version everywhere it lives (H-10). Run: pnpm version:set 1.0.0-rc.1
// Updates every package.json in the workspace and apps/server/src/version.ts. The Next.js app reads its footer version from
// apps/web/package.json, and the container images are tagged from the git tag by the release workflow, so nothing else needs editing.
// scripts/test/version.test.ts fails when any of these disagree.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <semver>, for example 1.0.0 or 1.0.0-rc.1");
  process.exit(2);
}
const manifests = ["package.json"];
for (const dir of ["apps", "packages"]) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (fs.existsSync(path.join(root, dir, name, "package.json"))) manifests.push(`${dir}/${name}/package.json`);
  }
}
for (const m of manifests) {
  const file = path.join(root, m);
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
}
fs.writeFileSync(path.join(root, "apps/server/src/version.ts"), `export const VERSION = "${version}";\n`);
console.log(`Set version ${version} in ${manifests.length} package.json files and apps/server/src/version.ts`);
