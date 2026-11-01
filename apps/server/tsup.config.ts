import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

// One bundle for the server process (dist/index.js) and one for worker threads (dist/worker.js).
// better-sqlite3 is native, so it stays external and is a direct dependency of this package.
export default defineConfig({
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  splitting: false,
  sourcemap: false,
  noExternal: [/^(?!better-sqlite3)/],
  external: ["better-sqlite3"],
  banner: {
    js: "import { createRequire as __nocon_createRequire } from 'module'; const require = __nocon_createRequire(import.meta.url);",
  },
  async onSuccess() {
    // The migration runner looks for ./migrations next to the bundle.
    cpSync("../../packages/db/migrations", "dist/migrations", { recursive: true });
  },
});
