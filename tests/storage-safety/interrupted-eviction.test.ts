import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "../integration/server/helpers.js";
import { allFiles, expectConsistent, startStorageTest } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runChild(env: Record<string, string>): Promise<{ signal: NodeJS.Signals | null; code: number | null }> {
  return new Promise((resolve, reject) => {
    const c = spawn(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "tests/storage-safety/evict-child.ts")], { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
    c.on("error", reject);
    c.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** Three Standard pages (3 000 bytes each, one of them sharing a stylesheet with a Protected page) and the Protected page. */
async function seedArchive(dataDir: string, rootsDir: string) {
  const t = await startStorageTest({ dataDir, rootsDir });
  const keep = t.seed.source({ name: "Keep", priority: 1, retention: { mode: "all" }, automaticEviction: true });
  const std = t.seed.source({ name: "Std", priority: 3 });
  const shared = { tag: "shared-css", bytes: 400 };
  const protectedPage = await t.seed.page({ url: "https://keep.test/p", sources: [keep], versions: [{ blobs: [{ tag: "keep-doc", bytes: 2000 }, shared] }] });
  const a = await t.seed.page({ url: "https://std.test/a", sources: [std], versions: [{ blobs: [{ tag: "a", bytes: 3000 }, shared] }] });
  const b = await t.seed.page({ url: "https://std.test/b", sources: [std], versions: [{ blobs: [{ tag: "b", bytes: 3000 }] }] });
  const c = await t.seed.page({ url: "https://std.test/c", sources: [std], versions: [{ blobs: [{ tag: "c", bytes: 3000 }] }] });
  const sig = { protectedSha: protectedPage.blobShas, protectedVersion: protectedPage.versionIds[0]!, std: [a, b, c].map((p) => p.versionIds[0]!) };
  await t.server.close();
  return sig;
}

const POINTS = ["run_started", "before_version", "in_version_txn", "after_version_txn", "before_blobs", "blob_marked", "blob_unlinked", "before_finalise", "after_finalise"] as const;

describe("T-05 kill the process at every step of an eviction, restart, and nothing protected is lost", () => {
  it.each(POINTS.flatMap((p) => (["before_version", "in_version_txn", "after_version_txn", "blob_marked", "blob_unlinked", "after_finalise"].includes(p) ? [[p, 1], [p, 2]] : [[p, 1]])) as [string, number][])(
    "killed at %s (occurrence %i)", async (point, nth) => {
      const dataDir = tempDir("ncb-evict-data-");
      const rootsDir = tempDir("ncb-evict-roots-");
      const sig = await seedArchive(dataDir, rootsDir);
      // Asking for 6 500 bytes evicts two Standard pages (6 000 bytes) plus the one that shares a stylesheet is only partly freed.
      const { signal, code } = await runChild({ CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir, FAULT_POINT: point, FAULT_NTH: String(nth), NEED_BYTES: "6000" });
      expect(signal === "SIGKILL" || code === 137, `child exited with code ${code} signal ${signal}`).toBe(true);

      const t = await startStorageTest({ dataDir, rootsDir, signIn: true }); // initialize() runs the recovery
      // Nothing Protected is lost: the row, the references and every file (including the stylesheet it shares with a Standard page).
      expect(t.seed.versionStatus(sig.protectedVersion)).toBe("ready");
      for (const sha of sig.protectedSha) expect(t.seed.blobExists(sha), `protected blob ${sha}`).toBe(true);
      expectConsistent(t, expect);
      // no row is left half way, and no file is left without a row or the other way round
      const files = allFiles(t).filter((f) => f.includes("blobs/"));
      const shas = t.svc.db.all<{ sha256: string }>("SELECT sha256 FROM blobs").map((r) => r.sha256);
      expect(files.map((f) => path.basename(f).replace(/\.zst$/, "")).sort()).toEqual([...shas].sort());
      // the eviction can be carried out again and completes
      const again = t.svc.storage.planAndStore({ bytesNeeded: 6000, incomingPriority: 1 });
      if (again.sufficient) await t.svc.storage.runPlan(again.planId);
      expectConsistent(t, expect);
      expect(t.seed.versionStatus(sig.protectedVersion)).toBe("ready");
      // the stylesheet shared with the evicted page survives, because the Protected page still uses it
      expect(t.seed.blobExists(sig.protectedSha[1]!)).toBe(true);
      // verify-and-repair finds nothing wrong with the storage invariants
      const report = await t.svc.storage.maintenance.verify({ checks: ["I-1", "I-2", "I-3", "I-4", "I-6", "I-8", "I-13"] });
      expect(report.findings, JSON.stringify(report.findings)).toEqual([]);
      // each eviction that happened has a reason on record
      const noReason = t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions v WHERE v.status = 'evicted' AND NOT EXISTS (SELECT 1 FROM storage_audit a WHERE a.version_id = v.id AND a.kind = 'evicted')")!.n;
      expect(noReason).toBe(0);
    },
  );

  it("a thrown fault inside the transaction rolls that version back completely", async () => {
    let armed = true;
    const t = await startStorageTest({ server: { storageFault: (p) => { if (armed && p === "in_version_txn") { armed = false; throw new Error("simulated failure"); } } } });
    const std = t.seed.source({ priority: 4 });
    const page = await t.seed.page({ url: "https://std.test/x", sources: [std], versions: [{ blobs: [{ tag: "x", bytes: 1000 }] }] });
    const plan = t.svc.storage.planAndStore({ bytesNeeded: 500, incomingPriority: 1 });
    await expect(t.svc.storage.runPlan(plan.planId)).rejects.toThrow("simulated failure");
    expect(t.seed.versionStatus(page.versionIds[0]!)).toBe("ready");
    expect(t.seed.blobExists(page.blobShas[0]!)).toBe(true);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM storage_audit")!.n).toBe(0);
    expectConsistent(t, expect);
  });
});
