import { ConfigError, loadConfig } from "@ncb/shared";
import { restoreBackup, RestoreError } from "./storage/backup.js";

/**
 * Command line tools that run with the server stopped (bundled as dist/cli.js):
 *   node dist/cli.js restore <backup folder> [--data-dir /data] [--force] [--replace-secret-key]
 */
function usage(): never {
  console.error("Usage: node dist/cli.js restore <backup folder> [--data-dir <dir>] [--force] [--replace-secret-key]");
  process.exit(64);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "restore") usage();
const flags = new Set(rest.filter((a) => a.startsWith("--") && a !== "--data-dir"));
const di = rest.indexOf("--data-dir");
const positional = rest.filter((a, i) => !a.startsWith("--") && !(di >= 0 && i === di + 1));
if (positional.length !== 1) usage();
let dataDir = di >= 0 ? rest[di + 1] : undefined;
if (!dataDir) {
  try { dataDir = loadConfig({ ...process.env, NODE_ENV: "development" }).NCB_DATA_DIR; } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(78); } throw e; }
}
try {
  const r = restoreBackup({ backupDir: positional[0]!, dataDir, force: flags.has("--force"), replaceSecretKey: flags.has("--replace-secret-key"), log: (m) => console.log(m) });
  console.log(`Restored ${r.restored.join(", ")} from a backup made ${r.manifest.createdAt} (${r.manifest.counts.pages} pages).`);
  if (r.keptOld) console.log(`The previous database was kept as ${r.keptOld}.`);
  for (const w of r.warnings) console.log(`- ${w}`);
} catch (e) {
  console.error(e instanceof RestoreError ? e.message : e instanceof Error ? e.message : String(e));
  process.exit(1);
}
