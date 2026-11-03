# Acceptance status

Where each of the 24 acceptance criteria stands, what shows it, and what is still open. "Met" means automated evidence exists and was run. It does not mean a person has checked it on every device. Anything that needs hardware or a person is not marked Met.

The specification summary says 28 criteria but lists 24. These are the 24 listed ([implementation-plan.md](implementation-plan.md#13-acceptance-criteria-traceability) section 13). If four more exist they still need to be supplied.

Status as of 3 November 2026, version 1.0.0-rc.1. Test counts for this state are in [the last section](#test-counts-for-this-state).

## Summary

| Status | Count | Criteria |
|---|---|---|
| Met | 19 | 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23 |
| Partly met | 4 | 1, 5, 21, 24 |
| Not met | 1 | 2 |

## Criteria

| # | Criterion | Status | Evidence | Outstanding |
|---|---|---|---|---|
| 1 | Docker Compose deployment on AMD64 and ARM64 | Partly met | CI job `images` builds the server, web and renderer images on `ubuntu-latest` and `ubuntu-24.04-arm` (`.github/workflows/ci.yml`). `docker compose up --wait` was run by hand on arm64 and, under emulation, on amd64 ([deployment.md](deployment.md#checks-that-were-run)). `tests/integration/server/hardening.test.ts` and `tests/integration/server/platform.test.ts` cover the server's behaviour. | CI builds the images but never starts the stack. A job that runs `docker compose up -d --wait` on both runners is still to be added ([release checklist](release/checklist.md)). Native amd64 and a tagged, published image have not been run. |
| 2 | Runs on a supported Raspberry Pi | Not met | The arm64 images build and the test suites pass on an arm64 CI runner and an Apple Silicon Mac. [guides/install.md](guides/install.md) covers the Pi. | No Raspberry Pi 4 or 5 has been available, so nothing has been run, timed or left running on one. Every Pi figure in [benchmarks.md](benchmarks.md) is "not measured". |
| 3 | Archive a single page | Met | `tests/e2e/09-capture.spec.ts`, `tests/integration/pipeline/capture.test.ts`, `tests/integration/pipeline/stages.test.ts` | None. |
| 4 | Crawl with configurable limits | Met | `tests/integration/crawl/engine.test.ts`, `tests/integration/crawl/traps.test.ts`, `tests/integration/storage/crawl-limits.test.ts`, `packages/crawl/test/scope.test.ts`, `tests/integration/downloads/limits.test.ts` | Crawl throughput on a Pi (PT-08, PT-09) is not measured. |
| 5 | Archived pages are browsable offline | Partly met | `tests/e2e/37-offline-end-to-end.spec.ts` saves a page and a package, turns Work offline on, refuses every browser request that is not to the app, and asserts that the fixture site saw no request from the server. `tests/e2e/15-offline-links.spec.ts`. | The Docker no-egress proof (`scripts/offline-test.sh`, HB-21) was not run in the final waves, and the Linux check that `web` has no route out (HB-02) has not been done. The browser and server behaviour is shown; the network isolation of the containers on Linux is not. |
| 6 | Links between archived pages resolve locally | Met | `tests/e2e/15-offline-links.spec.ts`, `tests/integration/pipeline/links.test.ts`, `tests/integration/archive/listener.test.ts` | None. |
| 7 | Reader mode | Met | `tests/e2e/09-capture.spec.ts`, `tests/e2e/12-shortcuts-indicators.spec.ts`, `tests/integration/archive/listener.test.ts`, `packages/content/test/readable.test.ts` | Reader quality on arbitrary real pages is only as good as the extractor; it has been checked on fixtures. |
| 8 | Search-engine homepage | Met | `tests/e2e/17-search-ui.spec.ts`, `tests/e2e/03-navigation.spec.ts` | None. |
| 9 | Typo tolerance and ranking | Met | `packages/search/test/quality.test.ts` (includes the `astronamy` case), `packages/search/test/ranking.test.ts`, `packages/search/test/engine.test.ts` | Ranking quality was judged on a synthetic and a Wikipedia-derived corpus, not on a real person's library. |
| 10 | Combined search merges local and online results | Met | `tests/integration/online/combined.test.ts`, `apps/server/test/online/rrf.test.ts`, `tests/e2e/20-online-search.spec.ts`, `tests/provider-conformance/conformance.test.ts` | Providers are tested against fakes. Real SearXNG, Brave and Mojeek responses were checked by hand in earlier phases, not in CI. |
| 11 | Provider failures do not block local search | Met | `tests/integration/online/failures.test.ts`, `tests/e2e/20-online-search.spec.ts`, `tests/e2e/18-search-ui-stubbed.spec.ts` | None. |
| 12 | Save online results for offline use | Met | `tests/integration/online/cache-and-sources.test.ts`, `tests/e2e/20-online-search.spec.ts`, `tests/e2e/37-offline-end-to-end.spec.ts` | None. |
| 13 | Sources and collections can be managed | Met | `tests/integration/sources/sources.test.ts`, `tests/integration/sources/collections.test.ts`, `tests/e2e/14-library-ui.spec.ts` | None. |
| 14 | Downloads can be scheduled and monitored | Met | `tests/integration/sources/schedule.test.ts`, `tests/integration/downloads/downloads.test.ts`, `tests/integration/downloads/refresh.test.ts`, `tests/e2e/14-library-ui.spec.ts` | None. |
| 15 | Discovery stays within limits | Met | `tests/discovery/runner-limits.test.ts`, `tests/discovery/property.test.ts`, `tests/discovery/search-driven.test.ts`, `tests/e2e/27-discovery-budget-runner.spec.ts` | None. |
| 16 | Priorities and retention work | Met | `packages/storage-planner/test/priority-retention.test.ts`, `tests/storage-safety/retention-respected.test.ts`, `tests/e2e/21-storage-overview.spec.ts`, `tests/e2e/22-storage-policy-volumes.spec.ts` | None. |
| 17 | P1 is never auto-evicted | Met | `tests/storage-safety/p1-never-evicted.test.ts`, `packages/storage-planner/test/property.test.ts`, `tests/storage-safety/interrupted-eviction.test.ts` | None. |
| 18 | Shared and protected assets are kept | Met | `tests/storage-safety/shared-assets.test.ts`, `tests/storage-safety/index-and-delete.test.ts`, `tests/storage-safety/zim-never-evicted.test.ts` | None. |
| 19 | The index can be rebuilt | Met | `tests/integration/search/rebuild.test.ts`, `tests/reliability/kill-restart.test.ts`; rebuild time at 20,000 and 500,000 pages is in [benchmarks.md](benchmarks.md#scale-test-500000-pages) | Rebuild time on a Pi is not measured (PT-12). |
| 20 | ZIM import and browsing | Met | `tests/integration/zim/registry.test.ts`, `tests/integration/zim/serve.test.ts`, `tests/integration/zim/search.test.ts`, `tests/e2e/30-packages-library.spec.ts`, `tests/e2e/31-package-browser.spec.ts`, `tests/e2e/32-package-search.spec.ts` | Tested on small fixture packages. A full English Wikipedia package (about 13 GB) was not imported (PT-16 not measured). |
| 21 | Usable offline | Partly met | `tests/e2e/37-offline-end-to-end.spec.ts` (twenty areas, each saying Offline with nothing loading), `tests/e2e/18-search-ui-stubbed.spec.ts` | Same gap as criterion 5: `scripts/offline-test.sh` and `tests/offline/check.mjs` (the Docker no-egress run) were not run in the final waves. |
| 22 | Clear errors and recovery | Met | `apps/web/test/errors.test.ts` (the error catalogue), `tests/e2e/38-error-ux.spec.ts`, `tests/reliability/failures-and-cleanup.test.ts`, `tests/reliability/kill-restart.test.ts`, `tests/reliability/power-loss.test.ts`, `tests/integration/storage/backup-restore.test.ts` | The e2e suite covers the fifteen most likely failures. It does not prove that every failure path in the code reaches the screen in plain words. |
| 23 | Tests for critical paths | Met | The named suites in `.github/workflows/ci.yml`: unit, integration, storage safety, discovery, reliability, security, and the browser tests on Chromium and Firefox; both architectures for everything except the browser tests | WebKit runs in CI as advisory (it could not be run on the development Mac). The browser tests run on amd64 only (HB-09). |
| 24 | Documentation | Partly met | [README.md](../README.md), [guides/install.md](guides/install.md), [guides/upgrade.md](guides/upgrade.md), [guides/troubleshooting.md](guides/troubleshooting.md), [guides/backup-restore.md](guides/backup-restore.md), [guides/privacy-and-providers.md](guides/privacy-and-providers.md), [guides/knowledge-packages.md](guides/knowledge-packages.md), [configuration.md](configuration.md), [api.md](api.md); `pnpm docs:check` (settings, routes and links agree with the code) runs in the unit suite | The install steps were followed on a Mac with Docker, not on a Pi. The commands in the guides are not run by a script in CI; only the settings, routes and links are checked. The manual screen reader pass in [accessibility.md](accessibility.md) is not done. |

## What needs a person or hardware

These are not Met and cannot be, from this machine:

| Item | Why it is open | Who or what closes it |
|---|---|---|
| Raspberry Pi 4 and 5 runs and benchmarks (criterion 2, PT-01 to PT-22 on a Pi) | No Pi hardware was available | A person with a Pi follows [guides/install.md](guides/install.md), then runs `pnpm bench:scale` and the other benchmarks in [benchmarks.md](benchmarks.md#reproduce) |
| Linux no-egress check of the containers (HB-02, HB-21; criteria 5 and 21) | The Docker stack could not be used without disturbing running containers on the development Mac, and Docker Desktop for Mac does not honour the network setting being tested | A Linux host or CI job runs `scripts/offline-test.sh` |
| Screen reader pass with VoiceOver, NVDA or Orca (H-05) | Needs a person | The checklist in [accessibility.md](accessibility.md) |
| Real Safari (H-11, HB-16) | Playwright's WebKit crashes at launch on macOS 26.0.1, and it is not Safari anyway | A person on a Mac with Safari, or the advisory CI WebKit step plus a manual pass |
| 400% zoom with real browser zoom (H-05) | The suite checks reflow at 320 CSS pixels, which is the same layout width, but not the browser's own zoom | A person |
| A tagged, published release | Publishing needs approval | The Human, using [release/checklist.md](release/checklist.md) |

## Test counts for this state

Run on 3 November 2026 on an Apple M4 Pro (arm64), Node 24.22.2, after the wave D changes:

| Command | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test` (unit) | 1,966 passed |
| `pnpm test:integration` | 701 passed, 8 skipped |
| `pnpm test:storage-safety` | 168 passed |
| `pnpm test:discovery` | 60 passed |
| `pnpm test:reliability` | 53 passed |
| `pnpm test:security` | 96 passed |
| `pnpm licence-audit` | 315 packages, all compatible with AGPL-3.0 |
| `pnpm test:e2e` (Chromium) | 290 passed, 3 skipped |
| `pnpm test:e2e:firefox` | 121 passed, 3 skipped |
| `pnpm docs:check`, `pnpm traceability` | ok (also run inside `pnpm test`) |

WebKit could not be run on this machine. The skipped end-to-end tests are the ones that need the mock API and are skipped against the real server. CI runs the same commands on amd64 and arm64 ([ci.yml](../.github/workflows/ci.yml)). `pnpm traceability` lists the evidence for every task in [traceability.md](traceability.md); run the commands in [guides/development.md](guides/development.md#tests) to repeat any of this.
