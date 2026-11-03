import { configDefaults, defineConfig } from "vitest/config";

// Kill-and-restart tests that belong to the reliability suite (H-01). They live next to the code they exercise but run only in that project.
const RELIABILITY_ELSEWHERE = ["tests/integration/pipeline/crash.test.ts", "tests/integration/crawl/kill.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts", "tests/provider-conformance/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...RELIABILITY_ELSEWHERE],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        // The named storage safety suite (task T-12): P1 never evicted, shared assets kept, retention respected, interrupted eviction safe,
        // index updated on delete, explicit deletion distinct from eviction. Also runs the planner's own truth-table and property tests.
        test: {
          name: "storage-safety",
          include: ["tests/storage-safety/**/*.test.ts", "packages/storage-planner/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        // The named discovery suite (task D-08): limits, offline behaviour, privacy, provenance, scoring, the kill switch and property tests of
        // "random settings never produce unbounded work".
        test: {
          name: "discovery",
          include: ["tests/discovery/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        // The named reliability suite (task H-01): kill and restart at every pipeline stage and during a crawl, an eviction run, an index rebuild,
        // a ZIM copy and a backup; interrupted downloads; temp-file cleanup; atomic finalisation; graceful shutdown under load; power-loss
        // simulation (SIGKILL with WAL, then integrity_check and the app's own verify). Includes the older kill tests listed in RELIABILITY_ELSEWHERE
        // and the interrupted-eviction test (which also stays in storage-safety).
        test: {
          name: "reliability",
          include: ["tests/reliability/**/*.test.ts", ...RELIABILITY_ELSEWHERE, "tests/storage-safety/interrupted-eviction.test.ts"],
          environment: "node",
          testTimeout: 240_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
