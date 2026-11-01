// Joins host details and per-limit results into one JSON document.
// Usage: node scripts/bench/assemble.mjs HOST.json IMAGE PLATFORM RUN.json...
import fs from "node:fs";

const [hostFile, image, platform, ...runFiles] = process.argv.slice(2);
if (!hostFile || !image || !platform) {
  console.error("usage: assemble.mjs HOST.json IMAGE PLATFORM RUN.json...");
  process.exit(2);
}
const host = JSON.parse(fs.readFileSync(hostFile, "utf8"));
const runs = runFiles.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
console.log(JSON.stringify({ benchmark: "queue", image, platform, host, runs }, null, 2));
