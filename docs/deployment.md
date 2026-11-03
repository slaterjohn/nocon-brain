# Deployment notes

How the Docker Compose stack is put together and how it was checked. The plan is in [architecture.md](architecture.md#11-docker-compose-deployment); this page records what was built (F-10, F-13, F-14).

## Files

| File | Purpose |
|---|---|
| `compose.yml` | The stack: `server`, `web`, and the optional `searxng` profile. The optional `renderer` profile (task C-16, see below) |
| `compose.offline.yml` | Override for the offline test: removes the published ports and makes every network internal |
| `docker/server/Dockerfile` | Server image. Targets `runtime` (default) and `bench` (adds the queue benchmark) |
| `docker/web/Dockerfile` | Next.js standalone image |
| `docker/renderer/Dockerfile`, `docker/renderer/seccomp.json` | Renderer image (Playwright `chromium_headless_shell` on `node:24-trixie-slim`) and Playwright's seccomp profile (Apache-2.0, copied from `microsoft/playwright` `utils/docker/seccomp_profile.json` on 2 November 2026) that lets Chromium create its sandbox without `--no-sandbox` (the container adds back only `CAP_SYS_CHROOT`, which the profile requires for `chroot`) |
| `docker/searxng/settings.yml` | SearXNG settings with the `json` format enabled |
| `.env.example` | Every setting, grouped and commented |
| `scripts/build-images.sh` | Builds both images for arm64 and amd64 |
| `scripts/offline-test.sh`, `tests/offline/check.mjs` | Starts the stack with no internet and runs the checks |
| `scripts/bench/run.sh` | Queue benchmark inside the arm64 server image ([benchmarks.md](benchmarks.md)) |

## Containers, ports and networks

| Service | Published | Networks | Notes |
|---|---|---|---|
| `web` | `NCB_WEB_PORT` (3000) | `frontend`, `backend` | Proxies `/api/*` to `http://server:3001` and adds the shared `NCB_PROXY_SECRET` |
| `server` | `NCB_ARCHIVE_PORT` (3002) | `backend`, `egress`, `render` | The API on 3001 is not published. The browser loads archived frames from the archive port directly |
| `searxng` (profile) | none | `egress` | Reach it from the server as `http://searxng:8080`. It is not on `backend`, where `web` talks to the API |
| `renderer` (profile) | none | `render` | Internal-only network shared with `server`, which runs the guarded forward proxy on it (port 3128). No route to the internet or the LAN. `server` is on `render` always; the network exists but is empty without the profile |

Differences from the sketch in architecture.md:

- `server` is not on `frontend`. A container with one internal and one masquerading network can pick the wrong default route, so the archive port is published through `egress` instead. `frontend` carries only `web`.
- The host port and the container port are the same number, so any URL the server builds from its archive port is correct.
- Publishing the API for debugging needs a compose override (`ports: ["127.0.0.1:3001:3001"]`). The API port has no setting to publish it. Requests from the host then reach the container from the Docker gateway, not from loopback, so send the `x-nocon-proxy-secret` header or set `NCB_API_PROXY_ONLY=false`.

`frontend` has IP masquerade off, which on a Linux host stops `web` reaching the internet. Docker Desktop on macOS does not honour that: `web` could still fetch `https://example.com` there. Treat it as defence in depth, not as the offline guarantee. The offline test removes the problem by making every network internal.

## Volumes

- `ncb-data` is mounted at `/data` (databases, secrets, temporary files).
- `ncb-volume` is mounted at `/volumes/default` (blobs and ZIMs). Set `NCB_VOLUME_PATH` to a host path for a bind mount. The directory must be writable by UID 1000, and Docker creates a missing one as root.
- `NCB_VOLUMES_ALLOWED_ROOTS` (default `/volumes`) lists the container paths the setup wizard accepts. To add a second root, add a mount line to `server` and list its path there.

## Images

- Base `node:24-trixie-slim`, run as `node` (UID 1000). The server starts under `tini`.
- Both build stages that run JavaScript tools use `--platform=$BUILDPLATFORM`, so `next build` never runs under QEMU.
- `better-sqlite3` is external to the bundle. A `native` stage on the target platform runs `npm install better-sqlite3@<version>` (the version is read from `pnpm-lock.yaml`) into `/app/node_modules` and loads it once as a smoke test. The npm package ships prebuilt `linux-x64` and `linux-arm64` binaries, so no compiler is installed and the image has none.
- `pnpm install` runs with `--ignore-scripts`. pnpm otherwise tries `node-gyp rebuild` for `better-sqlite3` because the package has a `binding.gyp`.
- `package.json` files for the install layer are collected automatically in a `manifests` stage, so a new workspace package does not need a Dockerfile edit.
- The server reads its `NCB_*` settings from `.env` (via `env_file`). `environment:` in `compose.yml` fixes only ports, paths and the secret.

## Hardening

Both services (the renderer adds back only `CAP_SYS_CHROOT`, see [security.md](security.md)): `read_only` root, `tmpfs` for `/tmp` (and the Next.js cache), `cap_drop: ALL`, `no-new-privileges`, `pids_limit`, `mem_limit`, `json-file` log rotation (10 MB x 3), `restart: unless-stopped`, `stop_grace_period: 30s`. The server also has `cpus`. `NCB_PROXY_SECRET` is required by Compose (`docker compose config` fails with a message if it is empty).

Health checks are in the images: the server calls `GET /api/system/health` (503 until migrations have run), the web container calls `GET /healthz`. `web` waits for `server` to be healthy.

## Checks that were run

Results and timings are in the F-10, F-13 and F-14 report. In short: `docker compose up -d --build --wait` on arm64 (native) and the offline test on both arm64 and amd64 (amd64 under QEMU). On restart the admin, storage volume, profile, setup state and the work-offline switch survive. After `kill -s KILL` the writer lock is replaced and jobs left `running` return to the queue.

## Known limits

- The renderer needs unprivileged user namespaces on the host (Chromium's sandbox; Playwright's seccomp profile allows them in Docker's filter). A host that forbids them (for example Ubuntu 24.04 with `kernel.apparmor_restrict_unprivileged_userns=1` in effect for the container) stops Chromium from starting; the `server` then keeps the plain capture and logs that rendering failed.
- Turning the renderer on needs two lines in `.env` (`COMPOSE_PROFILES=renderer`, `NCB_RENDERER_URL=http://renderer:8080`). Compose cannot set an environment variable on `server` only when another service's profile is active.
- The forward proxy listens only on `server`'s address inside the `render` network (HB-07). `NCB_RENDER_PROXY_HOST` is set to the network's subnet (`NCB_RENDER_SUBNET`, default `172.31.250.0/24`, fixed in `compose.yml`), and the server binds to its own address in that range. If the subnet clashes with one you use, change `NCB_RENDER_SUBNET` in `.env`. If the server has no address in the range the proxy does not start, rather than listening everywhere. It still refuses requests without the renderer secret.
- Jobs fail with `No handler named "fetch"` until the fetch handlers land in Phase 2. That is expected.
- The API still listens on all addresses inside the container, but it answers only requests that carry the proxy secret (from `web`) or come from the container itself (HB-01, `NCB_API_PROXY_ONLY`, default on). SearXNG and anything else on `egress` gets a 403. The secret also only counts from the `backend` subnet (`NCB_API_PROXY_FROM`, fixed in `compose.yml` as `NCB_BACKEND_SUBNET`, default `172.31.249.0/24`), because the renderer and SearXNG hold a copy of it by default and the renderer shares a network with `server` (HB-11). Change the subnet in `.env` if it clashes with one you use. Tests: `tests/integration/server/hardening.test.ts`, `tests/security/api-proxy-source.test.ts`.

## Backup, restore and scheduled maintenance

The server writes a backup of its databases daily, runs a full verify weekly, and rolls up old finished jobs; see [guides/backup-restore.md](guides/backup-restore.md) for the procedure and what is and is not in a backup. Settings (all in `.env`): `NCB_BACKUP_INTERVAL_HOURS` (24, `0` = off), `NCB_BACKUP_KEEP` (7), `NCB_BACKUP_INCLUDE_INDEX` (false), `NCB_VERIFY_INTERVAL_HOURS` (168, `0` = off), `NCB_JOB_RETENTION_DAYS` (7, `0` = keep). Restore runs `node dist/cli.js restore <backup folder>` in the server image with the server stopped. Back up the storage volumes yourself, after the database backup.

## Online search providers (Phase 5)

Online search is off until the Human turns it on (Settings, Online search; the disclosure must be read and confirmed once). Providers are added under Settings, Search providers (`/api/search/providers`, api.md 6.2). For the bundled SearXNG: start the `searxng` profile, add a provider of type SearXNG with the address `http://searxng:8080`. The server's SSRF guard still refuses private addresses for everything else; a provider's own address (host and port) is the only exception, and only for that provider. Brave and Mojeek need an API key (stored encrypted with `NCB_SECRET_KEY`; if the key is lost the credentials must be entered again). Nothing is sent to any provider while online search is off, no provider is enabled, "work offline" is on, or the server knows the connection is down. To try a real SearXNG without the web server, publish a port with a compose override file and run `SEARXNG_URL=http://127.0.0.1:18080 node --import tsx scripts/manual-searxng-check.ts "your query"`.

## Wikipedia

Wikipedia features (saving an article, the topic crawl, the preview) need `NCB_CONTACT` in `.env`: a web address or an email address that reaches the person who runs the server, for example `NCB_CONTACT=https://example.org/about-me`. Wikimedia asks every client to identify itself, and NoConBrain sends it in the User-Agent of each request; without it no request is made. Requests go out one at a time, at most one a second. A downloaded Wikipedia package (a `.zim` file, imported under Settings, Knowledge packages) is the better way to keep a lot of Wikipedia: it works offline, adds no load to Wikipedia, and an article the package holds is linked to the package copy instead of being fetched. `scripts/manual-wikipedia-check.ts` makes two requests to the real service to check a contact (api.md 15.2).

## Phase 9 wave 1 smoke check (arm64, Docker Desktop for Mac)

`docker compose build` could not run: the Docker VM had no route to the internet, so the `docker/dockerfile:1.7` frontend could not be pulled. The stack was started from the existing images with the freshly built `apps/server/dist` mounted over `/app/dist` (`docker compose up -d --no-build --wait` with the `searxng` and `renderer` profiles). Results: `server`, `web`, `searxng` and `renderer` healthy; the web port answers 200 and `/api/settings` through it reaches the application; from `searxng` and from `web` a direct call to `http://server:3001/api/settings` returns 403 and the health route answers; the renderer proxy listens on 172.31.250.x only, `renderer` connects to it and `web` gets `ECONNREFUSED`. The Dockerfiles themselves were not rebuilt, so CI's image build is the check for them.
