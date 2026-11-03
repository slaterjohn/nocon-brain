# Changelog

All notable changes to NoConBrain are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/). Dates are added when a version is tagged.

## [1.0.0-rc.1] - not yet tagged

The first release candidate. Everything in the nine phases of the [implementation plan](docs/implementation-plan.md) is built except the items it lists as post-v1. [docs/acceptance.md](docs/acceptance.md) says which of the 24 acceptance criteria are met, which are partly met and which are not, and why.

### Added

- Archiving: capture a single page or crawl a site with limits for depth, page count, size and rate, with robots.txt and a per-host delay. Pages are stored with their images and style sheets and open offline in an isolated frame, with a reader view, find in page, bookmarks and history.
- Sources, collections, schedules and download windows, with a Downloads view that shows progress and lets you pause, resume, cancel and retry.
- Local search on SQLite FTS5: typo tolerance, synonyms, filters, saved searches, suggestions and a search history that can be switched off.
- Combined search: local results merged with SearXNG, Brave and Mojeek results by reciprocal rank fusion, shown progressively, with providers off by default and a disclosure before the first use. A failing provider never blocks local results.
- Intelligent storage: four priorities (P1 Protected to P4 Opportunistic), retention per source, an eviction planner that never removes P1 content, shared assets kept while anything uses them, space reservations for downloads, and a record of every removal.
- Discovery: candidate pages from links and searches, scored and bounded by budgets, off by default, with a kill switch.
- Knowledge packages: import and browse ZIM files, search them together with the archive, and open Wikipedia articles from a package when one is installed. Live Wikipedia capture goes through a polite, identified client.
- Optional renderer container for pages that are empty until their scripts run, reachable only through a guarded proxy.
- Backups (`VACUUM INTO`, checksummed manifest), a restore command, a verify tool that checks thirteen invariants, scheduled maintenance and job roll-up.
- A security suite: authorisation matrix over every route, SSRF corpus, XSS corpus run in real browsers, and isolation checks for archived content.
- Accessibility checks with axe on 33 routes in both themes, keyboard paths, reduced motion and reflow at 320 CSS pixels.
- An error catalogue so that every API error reaches the screen as a sentence with a next step.
- A footer on every page with the version, the licence and a link to the source code (AGPL-3.0 section 13).
- `pnpm bench:scale` builds a synthetic library of any size and measures search, index rebuild, storage planning, verify, library paging, start-up and memory.
- `pnpm traceability` maps every requirement ID in the plan to its code and tests and fails when one has none. `pnpm docs:check` checks that settings, routes and links in the documentation match the code.
- Guides for installing (including a Raspberry Pi and a reverse proxy with HTTPS), upgrading, troubleshooting, privacy and providers, and knowledge packages, plus a settings reference.
- `NCB_REGISTRY` in `compose.yml`, so the same file can pull published images instead of building them.

### Changed

- The database has one more migration (`0016_blob_reference_indexes`); the server takes its usual pre-migration copy before applying it.
- The user agent falls back to `dev` rather than a fixed old version number when no version is passed.

### Fixed

- The API's access checks were skipped for a percent-encoded path such as `/%61pi/settings` (HB-10).
- The Downloads page was 641 pixels wide at 320 pixels, and its tab panel had no visible focus (HB-18, HB-19).
- Technical error text such as `ENOSPC` reached the screen unchanged, and an expired session gave no explanation (HB-20).
- Verify, the storage pass and the eviction planner slowed with the square of the library, because looking up what still uses a stored file scanned a whole table (HB-24). Migration `0016_blob_reference_indexes` adds the missing indexes. At 30,000 pages verify's reference-count check fell from 63 s to 29 ms.
- Rebuilding the search index used about 40 KB of memory per page, which would have been over 20 GB for 500,000 pages (HB-25). It now prepares its database statements once; at 30,000 pages the process after a rebuild went from 1,857 to 807 MiB.
- See [docs/hardening-backlog.md](docs/hardening-backlog.md) for the full list with tests.

### Known gaps

- Not run on a Raspberry Pi. Every Pi figure in [docs/benchmarks.md](docs/benchmarks.md) is marked as not measured.
- The Docker no-egress check (`scripts/offline-test.sh`) and the Linux check of the `frontend` network (HB-02, HB-21) have not been run since the last changes.
- WebKit runs in CI as advisory only; real Safari and a screen reader have not been tried by a person.
- Open advisories in development tools only (HB-15); base images are tagged, not pinned by digest (HB-17).

[1.0.0-rc.1]: https://github.com/slaterjohn/nocon-brain/releases/tag/v1.0.0-rc.1
