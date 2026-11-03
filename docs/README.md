# NoConBrain documentation

NoConBrain is a self-hosted, offline-first knowledge archiver, crawler and search engine, part of the NoCon family. It is in **planning**: these documents describe what will be built. No application code exists.

## Planning documents

| Document | What it answers |
|---|---|
| [architecture.md](architecture.md) | Service boundaries, data flow diagrams, database, search, crawling, storage, offline behaviour, security boundaries, Raspberry Pi profile, Docker Compose deployment and environment variables |
| [technology-decisions.md](technology-decisions.md) | For each decision: options considered, evidence from the research, the decision and Pi considerations; plus 14 decisions made while planning (D-1 to D-14) |
| [data-model.md](data-model.md) | The proposed SQLite schema (`main.db` and the separate `index.db`), key relationships, effective-priority and eviction-eligibility rules, retention, rebuild path, integrity invariants |
| [api.md](api.md) | Resource-by-resource endpoints with TypeScript-style shapes, auth and CSRF rules, progressive search over SSE, and the archive listener URL scheme and link-rewriting rules |
| [implementation-plan.md](implementation-plan.md) | Nine phases split into small, testable tasks with IDs, dependencies, acceptance checks, MVP/v1/Post-v1 scope, performance targets (to be measured), deferred requirements and acceptance-criteria traceability |
| [deployment.md](deployment.md) | What the Docker Compose stack looks like as built: images, networks, volumes, hardening, checks and known limits |
| [benchmarks.md](benchmarks.md) | Measured numbers with the hardware they came from |
| [risk-register.md](risk-register.md) | Risks with likelihood, impact, mitigation and owner phase |
| [security.md](security.md) | Threat model, isolation design, container hardening, secrets, and the results of the security review (authorisation matrix, SSRF fuzzing, XSS, isolation, SBOM) |
| [browser-support.md](browser-support.md) | Supported browsers, what runs in each, how to run the matrix, known differences and gaps |
| [hardening-backlog.md](hardening-backlog.md) | Findings from verification and review, with their status |

Suggested reading order: architecture, technology decisions, data model, API, then the plan.

## Research behind the decisions

| File | Topic |
|---|---|
| [research/search-engines.md](research/search-engines.md) | FTS5 vs Meilisearch vs Typesense (and Tantivy, Manticore); benchmark method and results |
| [research/search-bench/](research/search-bench/) | Benchmark scripts, queries and raw JSON results (`results/`); the corpus under `data/` is not committed |
| [research/zim-wikipedia.md](research/zim-wikipedia.md) | ZIM format, `@openzim/libzim`, federated search, rendering ZIM content, live Wikipedia archiving, licensing |
| [research/search-providers.md](research/search-providers.md) | SearXNG, Brave, Mojeek and others; storage terms; adapter interface; rank fusion and progressive ordering |
| [research/crawling-rendering.md](research/crawling-rendering.md) | Crawler libraries, optional rendering, capture format, extraction, safe offline rendering, SSRF, job queue |
| [research/poc-archive-isolation/](research/poc-archive-isolation/) | Throwaway proof-of-concept scripts for the isolation tests, SSRF guard and queue benchmark |

All benchmark numbers in the research come from an Apple Silicon Mac running native `linux/arm64` containers, **not a Raspberry Pi**. Nothing in these documents claims Pi performance; targets are marked "to be measured".

## Conventions

- UK English, sentence-case headings, plain and specific language.
- Priorities are **P1 Protected, P2 Important, P3 Standard, P4 Opportunistic** (lower number is more important). NoConMedia uses P0 to P3; the numbering differs and the names differ.
- Task IDs use a phase letter (F, A, C, S, O, T, D, Z, H) so they do not clash with priority names.
- NoConBrain copies patterns from the sister project NoConMedia (monorepo layout, scrypt sessions, CSRF header, proxy-secret client IP, path safety, deterministic storage planner, Docker patterns, test tooling, acceptance honesty). It imports no packages from it.
- Licence: AGPL-3.0, public repository `slaterjohn/nocon-brain`.

## Decisions to confirm before Phase 1

These were made while planning and go beyond the owner's list. Details are in [technology-decisions.md](technology-decisions.md#additional-decisions-made-in-this-plan).

1. Archive URL scheme `/a/{token}/…` with `p`, `v`, `m`, `z` route classes (D-1).
2. A fourth worker kind, `search`, for read-only index queries (D-2).
3. Server-Sent Events for progressive search, with a polling fallback (D-3).
4. Renderer traffic only through a guarded proxy in `server`, on an internal-only network (D-4).
5. Address-bar sync through server-side frame state, and find-in-page through server-side highlighting, both subject to browser spikes (D-5, D-6).
6. Cookie name `ncb_session` (D-7); connectivity detection without telemetry (D-8).
7. Wikipedia articles fetched through `/with_html`, with `/html` kept behind an adapter as a fallback (D-13).
8. The specification summary says 28 acceptance criteria but lists 24; the plan maps the 24 listed.
