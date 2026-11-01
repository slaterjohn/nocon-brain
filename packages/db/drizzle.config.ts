import { defineConfig } from "drizzle-kit";

// Used only for the F-03 spike and for `pnpm db:generate` drift checks. Output goes to a scratch
// folder, never to migrations/ (see docs/implementation-plan.md, F-03 spike result).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./.drizzle-scratch",
});
