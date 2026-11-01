import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One writer per database file. A second `server` instance on the same data directory must refuse to
 * start (docs/architecture.md, single-writer rule).
 *
 * The lock is a file created with `wx` holding the owner's pid. A lock whose pid is dead is stale and is
 * replaced. A lock with our own pid that this process does not hold is also stale: in a container
 * the server is usually pid 1, so after a restart the old lock names the new process's own pid.
 * Limit: this does not protect against two containers that each run as pid 1 on a shared volume;
 * the compose file runs a single `server` service.
 */
export class WriterLockError extends Error {
  readonly lockPath: string;
  readonly holderPid: number;
  constructor(lockPath: string, holderPid: number) {
    super(`Another NoConBrain server (pid ${holderPid}) already holds the database lock ${lockPath}. Stop it before starting a second one.`);
    this.name = "WriterLockError";
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

interface LockFile {
  pid: number;
  host: string;
  startedAt: number;
}

const heldInThisProcess = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): LockFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LockFile;
    return typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export class WriterLock {
  private released = false;
  private constructor(readonly lockPath: string, private readonly onExit: () => void) {}

  static acquire(lockPath: string): WriterLock {
    const abs = path.resolve(lockPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (heldInThisProcess.has(abs)) throw new WriterLockError(abs, process.pid);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body: LockFile = { pid: process.pid, host: os.hostname(), startedAt: Date.now() };
        fs.writeFileSync(abs, JSON.stringify(body), { flag: "wx" });
        heldInThisProcess.add(abs);
        const onExit = () => {
          try { fs.unlinkSync(abs); } catch { /* already gone */ }
        };
        process.once("exit", onExit);
        return new WriterLock(abs, onExit);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const holder = readLock(abs);
        if (holder && holder.pid !== process.pid && pidAlive(holder.pid)) throw new WriterLockError(abs, holder.pid);
        // Stale (dead pid, our own pid from a previous life, or unreadable): remove and retry.
        try { fs.unlinkSync(abs); } catch { /* raced with another process; retry decides */ }
      }
    }
    throw new WriterLockError(abs, readLock(abs)?.pid ?? -1);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    heldInThisProcess.delete(this.lockPath);
    process.removeListener("exit", this.onExit);
    this.onExit();
  }
}
