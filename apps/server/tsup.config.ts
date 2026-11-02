import { cpSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineConfig } from "tsup";

// css-tree's source build reads its data tables with createRequire(...)("../data/patch.json"), which esbuild cannot follow, so
// the bundle would fail to start. This plugin turns those requires into static JSON imports, which esbuild inlines.
const cssTreeJson = {
  name: "css-tree-json",
  setup(build: import("esbuild").PluginBuild) {
    build.onLoad({ filter: /css-tree[\\/]lib[\\/](data|data-patch|version)\.js$/ }, (args) => {
      const src = readFileSync(args.path, "utf8");
      const imports: string[] = [];
      const body = src
        .replace(/^import \{ createRequire \} from 'module';\n/m, "")
        .replace(/^const require = createRequire\(import\.meta\.url\);\n/m, "")
        .replace(/^const (\{[^}]*\}|\w+) = require\('([^']+)'\)(\.\w+)?;$/gm, (_m, name: string, mod: string, prop?: string) => {
          const id = `__json${imports.length}`;
          imports.push(`import ${id} from '${mod}';`);
          return `const ${name} = ${id}${prop ?? ""};`;
        });
      return { contents: imports.join("\n") + "\n" + body, loader: "js", resolveDir: dirname(args.path) };
    });
  },
};

// One bundle for the server process (dist/index.js) and one for worker threads (dist/worker.js).
// better-sqlite3 and @openzim/libzim are native, so they stay external and are direct dependencies of this package.
export default defineConfig({
  entry: { index: "src/index.ts", worker: "src/worker.ts", "index-worker": "src/search/index-worker.ts", "search-worker": "src/search/search-worker.ts", "zim-worker": "src/zim/zim-worker.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  splitting: false,
  sourcemap: false,
  noExternal: [/^(?!better-sqlite3|@openzim\/libzim)/],
  esbuildPlugins: [cssTreeJson],
  external: ["better-sqlite3", "@openzim/libzim"],
  banner: {
    js: "import { createRequire as __nocon_createRequire } from 'module'; const require = __nocon_createRequire(import.meta.url);",
  },
  async onSuccess() {
    // The migration runner looks for ./migrations next to the bundle.
    cpSync("../../packages/db/migrations", "dist/migrations", { recursive: true });
  },
});
