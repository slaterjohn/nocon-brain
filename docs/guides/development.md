# Development

## Requirements

- Node 24 (`.nvmrc`) and pnpm 10 (`corepack enable`).
- Docker, only for the container checks and the renderer integration test.

## Install

```sh
pnpm install
```

No compiler is needed for the core. `better-sqlite3` ships prebuilt binaries for macOS, Linux (glibc and musl) and Windows, and `pnpm-workspace.yaml` stops pnpm from running its `node-gyp rebuild` step (the package has a `binding.gyp`, which makes pnpm try to compile it unless told not to). If you see a `node-gyp` error, check that `better-sqlite3` is not listed under `onlyBuiltDependencies`, and that you are on Node 24: a prebuilt binary is tied to the Node ABI.

Knowledge packages are the exception. `@openzim/libzim` has no prebuilt Node binary: its install script downloads libzim for your platform and compiles a small wrapper with node-gyp. Installing it therefore needs `python3`, `make` and a C++ compiler (Xcode command line tools on macOS, `build-essential` on Debian and Ubuntu). It is the only dependency that does. If the compile fails, `pnpm install` fails with it, so install a compiler first. The Docker image builds libzim in its own stage, so the runtime image has no compiler.

## Tests

| Command | What it runs |
|---|---|
| `pnpm typecheck` | TypeScript for every package and the tests |
| `pnpm test` | Unit tests |
| `pnpm test:integration` | Server tests with real databases and fixture sites |
| `pnpm test:storage-safety` | The storage safety suite |
| `pnpm test:discovery` | The discovery suite |
| `pnpm test:reliability` | The reliability suite: kill and restart, power loss, shutdown, failures |
| `pnpm licence-audit` | Licence check of dependencies |
| `pnpm test:e2e` | Playwright; needs ports 25000 to 25002 free |

Automated tests never use the network. The reliability suite starts and kills real server processes; set `RELIABILITY_SEED` to repeat a particular set of kill times.
