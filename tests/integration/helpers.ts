import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];

/** A fresh temp directory removed after the test. */
export function tempDir(prefix = "ncb-it-"): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
