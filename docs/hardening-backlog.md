# Hardening backlog

Findings from verification runs that are deferred to Phase 9 (Hardening) or an earlier phase where noted. Each entry says where it was found and what a fix looks like.

| ID | Finding | Found in | Proposed fix | Target |
|---|---|---|---|---|
| HB-01 | The API listens on `0.0.0.0:3001`, so any container on the `egress` network (for example SearXNG) can reach it directly. Session auth still applies and forwarded client IPs are ignored without the proxy secret, so the exposure is limited. | Phase 1 Docker verification | Bind the API to the `backend` network address only, or require the proxy secret on every API request that does not come from loopback. | Phase 9 |
| HB-02 | `web` could reach the internet on Docker Desktop for Mac even though the `frontend` network disables IP masquerading. Expected to hold on Linux but unverified. | Phase 1 Docker verification | Verify on a Linux host; if egress works there too, move `web` to internal networks only and publish through a dedicated ingress network. | Phase 9 |
| HB-03 | A fresh `pnpm install` tries to compile `better-sqlite3` with node-gyp because the package has a `binding.gyp`; the Dockerfiles use `--ignore-scripts` and install the prebuilt binary separately. | Phase 1 Docker build | Document in the development guide; consider `onlyBuiltDependencies` / prebuild install so local installs never need a compiler. | Phase 9 |
| HB-04 | Crawl `maxDuration` deadline uses the wall clock, so a clock jump (Pi without RTC) can end a crawl early. | Phase 3 crawl engine | Measure elapsed time with `steadyClock` from `@ncb/shared`, like leases. | Phase 9 |
| HB-05 | robots.txt and the first page request run inside one claimed job, so they are not spaced; assets within a page are not spaced individually (`assetConcurrency` 1 only). | Phase 3 crawl engine | Route robots and asset fetches through the per-host politeness gate, or document the bounded burst. | Phase 9 |
| HB-06 | `maxBytes` can overshoot by roughly one page. | Phase 3 crawl engine | Reserve the per-document cap against the remaining budget before fetching. | Phase 9 |
| HB-07 | The renderer forward proxy listens on all interfaces inside `server`, so `web` and `searxng` can reach it. It refuses requests without the shared secret. | Phase 3 renderer | Bind the proxy to the `render` network address only. | Phase 9 |
| HB-08 | The renderer container needs `CAP_SYS_CHROOT` for Chromium's sandbox under Playwright's seccomp profile. | Phase 3 renderer | Keep the single capability; document it in the security guide; revisit if a rootless sandbox option appears. | Phase 9 |
