import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@ncb/db";
import { expect } from "vitest";
import type { Services } from "@ncb/server";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface Child {
  proc: ChildProcess;
  lines: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves with the first line (already seen or not) that matches. */
  waitFor(re: RegExp, ms?: number): Promise<string>;
  /** SIGKILL, then wait for the process to be gone. */
  kill(): Promise<void>;
}

/** Starts a TypeScript file as a separate node process (with the tsx loader, so the PID is the server's own and SIGKILL reaches it). stdout lines are collected; stderr goes to the test output. */
export function startChild(file: string, env: Record<string, string>): Child {
  const proc = spawn(process.execPath, ["--import", "tsx", file], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const lines: string[] = [];
  const waiters: { re: RegExp; resolve(l: string): void }[] = [];
  let buf = "";
  proc.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      lines.push(line);
      for (const w of [...waiters]) if (w.re.test(line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    proc, lines, exited,
    waitFor(re, ms = 60_000) {
      const seen = lines.find((l) => re.test(l));
      if (seen) return Promise.resolve(seen);
      return new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${re} (saw: ${lines.slice(-5).join(" | ")})`)), ms);
        waiters.push({ re, resolve: (l) => { clearTimeout(t); resolve(l); } });
        void exited.then((e) => { clearTimeout(t); reject(new Error(`child exited (code ${e.code}, signal ${e.signal}) before ${re} appeared; saw: ${lines.slice(-5).join(" | ")}`)); });
      });
    },
    async kill() {
      proc.kill("SIGKILL");
      await exited;
    },
  };
}

export const CHILD = path.join(ROOT, "tests/reliability/child.ts");

export function expectKilled(r: { code: number | null; signal: NodeJS.Signals | null }): void {
  expect(r.signal === "SIGKILL" || r.code === 137, `expected SIGKILL, got code ${r.code} signal ${r.signal}`).toBe(true);
}

/** `PRAGMA integrity_check` on a SQLite file, opened the ordinary way (so a WAL left by a killed writer is replayed first). `[]` when healthy. */
export function integrity(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const d = openDb(file, { createDir: false });
  try {
    return d.all<{ integrity_check: string }>("PRAGMA integrity_check").map((r) => r.integrity_check).filter((m) => m !== "ok");
  } finally {
    d.close();
  }
}

/** Every file in a directory tree, relative, for "no half-written file is left" assertions. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** The app's own verify over every invariant. Returns the findings (REF, "not referenced", is reported but is not damage). */
export async function verifyAll(svc: Services): Promise<{ invariant: string; count: number; examples: string[] }[]> {
  const run = await svc.storage.maintenance.verify({ sampleBlobs: 10_000 });
  expect(run.state).toBe("done");
  return run.findings.filter((f) => f.invariant !== "REF").map((f) => ({ invariant: f.invariant, count: f.count, examples: f.examples }));
}
