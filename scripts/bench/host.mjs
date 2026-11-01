// Prints host details as JSON, for docs/benchmarks.md. Usage: node scripts/bench/host.mjs
// "pi" is "not a Pi" unless /proc/device-tree/model names a Raspberry Pi.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

let model = null;
try {
  model = fs.readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
} catch {
  /* not a device-tree machine */
}
const cpus = os.cpus();
const docker = sh("docker", ["info", "--format", "{{json .}}"]);
let dockerInfo = null;
if (docker) {
  try {
    const d = JSON.parse(docker);
    dockerInfo = {
      serverVersion: d.ServerVersion,
      operatingSystem: d.OperatingSystem,
      architecture: d.Architecture,
      cpus: d.NCPU,
      memoryGiB: Number((d.MemTotal / 2 ** 30).toFixed(1)),
      storageDriver: d.Driver,
    };
  } catch {
    /* ignore */
  }
}

console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      cpu: cpus[0]?.model ?? "unknown",
      cores: cpus.length,
      arch: os.arch(),
      os: `${os.type()} ${os.release()}`,
      memoryGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)),
      node: process.version,
      deviceModel: model,
      pi: model && /raspberry pi/i.test(model) ? model : "not a Pi",
      docker: dockerInfo,
    },
    null,
    2,
  ),
);
