import { defineConfig } from "vitest/config";

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
    ],
  },
});
