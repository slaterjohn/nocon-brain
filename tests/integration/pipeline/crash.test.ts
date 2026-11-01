import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PIPELINE_STAGES } from "@ncb/db/schema";
import { tempDir } from "../server/helpers.js";
import { startPipelineServer, until, useFixtures } from "./helpers.js";

const fixtures = useFixtures();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function runChild(env: Record<string, string>): Promise<{ signal: NodeJS.Signals | null; code: number | null }> {
  return new Promise((resolve, reject) => {
    const c = spawn(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "tests/integration/pipeline/crash-child.ts")], {
      cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"],
    });
    c.on("error", reject);
    c.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

type T = Awaited<ReturnType<typeof startPipelineServer>>;
function signature(t: T) {
  const q = <X>(sql: string) => t.svc.db.get<X>(sql)!;
  const v = q<Record<string, unknown>>("SELECT status, title, content_hash, word_count, raw_hash, total_bytes, partial_reason FROM page_versions");
  const count = (table: string) => q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).n;
  return {
    v,
    pages: count("pages"), versions: count("page_versions"), assets: count("assets"), refs: count("asset_references"), links: count("links"),
    resources: count("version_resources"), blobs: count("blobs"), aliases: count("page_aliases"), content: count("version_content"),
    refTotal: q<{ n: number }>("SELECT SUM(refcount) AS n FROM blobs").n,
    stages: t.svc.db.all<{ stage: string; state: string }>("SELECT stage, state FROM pipeline_stage_runs ORDER BY stage"),
  };
}

describe("A-05 kill the process and resume", () => {
  const url = () => `${fixtures().urls.article}/solar-power`;
  let baseline: ReturnType<typeof signature>;

  it("baseline: an uninterrupted capture", async () => {
    const t = await startPipelineServer();
    const r = await (async () => {
      const { downloadId } = t.pipeline.captureUrl(url());
      return until(() => { const c = t.pipeline.getCapture(downloadId); return c?.state === "completed" ? c : undefined; });
    })();
    expect(r.outcome).toBe("created");
    baseline = signature(t);
    expect(baseline.v.status).toBe("ready");
  });

  it.each([...PIPELINE_STAGES])("killed right after stage %s: the next run completes with identical results", async (stage) => {
    const dataDir = tempDir("ncb-crash-data-");
    const rootsDir = tempDir("ncb-crash-roots-");
    const { signal, code } = await runChild({ CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir, CAPTURE_URL: url(), CRASH_AFTER: stage });
    expect(signal === "SIGKILL" || code === 137, `child exited with code ${code} signal ${signal}`).toBe(true);
    const t = await startPipelineServer({ dataDir, rootsDir });
    await until(() => t.svc.db.get<{ s: string }>("SELECT status AS s FROM page_versions")?.s === "ready", 30_000);
    await until(() => t.svc.db.get<{ s: string }>("SELECT state AS s FROM download_jobs")?.s === "completed");
    const sig = signature(t);
    expect(sig).toEqual(baseline);
    // no reader ever saw a capturing version: while capturing, the page had no latest version (checked structurally)
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE latest_version_id IS NOT NULL AND latest_version_id NOT IN (SELECT id FROM page_versions WHERE status IN ('ready','partial'))")!.n).toBe(0);
  });

  it("killed in the middle of a stage (work done, not marked done) resumes without duplicating rows or blobs", async () => {
    for (const stage of ["assets", "readable", "normalise"]) {
      const dataDir = tempDir("ncb-crash-data-");
      const rootsDir = tempDir("ncb-crash-roots-");
      const { signal, code } = await runChild({ CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir, CAPTURE_URL: url(), CRASH_BEFORE_DONE: stage });
      expect(signal === "SIGKILL" || code === 137, `child exited with code ${code} signal ${signal}`).toBe(true);
      const t = await startPipelineServer({ dataDir, rootsDir });
      await until(() => t.svc.db.get<{ s: string }>("SELECT status AS s FROM page_versions")?.s === "ready", 30_000);
      expect(signature(t)).toEqual(baseline);
      expect(t.svc.db.get<{ a: number }>("SELECT attempts AS a FROM pipeline_stage_runs WHERE stage = ?", [stage])!.a).toBe(2);
    }
  });
});
