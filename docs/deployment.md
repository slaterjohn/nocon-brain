# Deployment notes

How the Docker Compose stack is put together and how it was checked. The plan is in [architecture.md](architecture.md#11-docker-compose-deployment); this page records what was built (F-10, F-13, F-14).

## Files

| File | Purpose |
|---|---|
| `compose.yml` | The stack: `server`, `web`, and the optional `searxng` profile. A commented `renderer` placeholder waits for Phase 3 (task C-16) |
| `compose.offline.yml` | Override for the offline test: removes the published ports and makes every network internal |
| `docker/server/Dockerfile` | Server image. Targets `runtime` (default) and `bench` (adds the queue benchmark) |
| `docker/web/Dockerfile` | Next.js standalone image |
| `docker/searxng/settings.yml` | SearXNG settings with the `json` format enabled |
| `.env.example` | Every setting, grouped and commented |
| `scripts/build-images.sh` | Builds both images for arm64 and amd64 |
| `scripts/offline-test.sh`, `tests/offline/check.mjs` | Starts the stack with no internet and runs the checks |
| `scripts/bench/run.sh` | Queue benchmark inside the arm64 server image ([benchmarks.md](benchmarks.md)) |

## Containers, ports and networks

| Service | Published | Networks | Notes |
|---|---|---|---|
| `web` | `NCB_WEB_PORT` (3000) | `frontend`, `backend` | Proxies `/api/*` to `http://server:3001` and adds the shared `NCB_PROXY_SECRET` |
| `server` | `NCB_ARCHIVE_PORT` (3002) | `backend`, `egress` | The API on 3001 is not published. The browser loads archived frames from the archive port directly |
| `searxng` (profile) | none | `backend`, `egress` | Reach it from the server as `http://searxng:8080` |

Differences from the sketch in architecture.md:

- `server` is not on `frontend`. A container with one internal and one masquerading network can pick the wrong default route, so the archive port is published through `egress` instead. `frontend` carries only `web`.
- The host port and the container port are the same number, so any URL the server builds from its archive port is correct.
- Publishing the API for debugging needs a compose override (`ports: ["127.0.0.1:3001:3001"]`). There is no `NCB_API_BIND` setting yet.

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

Both services: `read_only` root, `tmpfs` for `/tmp` (and the Next.js cache), `cap_drop: ALL`, `no-new-privileges`, `pids_limit`, `mem_limit`, `json-file` log rotation (10 MB x 3), `restart: unless-stopped`, `stop_grace_period: 30s`. The server also has `cpus`. `NCB_PROXY_SECRET` is required by Compose (`docker compose config` fails with a message if it is empty).

Health checks are in the images: the server calls `GET /api/system/health` (503 until migrations have run), the web container calls `GET /healthz`. `web` waits for `server` to be healthy.

## Checks that were run

Results and timings are in the F-10, F-13 and F-14 report. In short: `docker compose up -d --build --wait` on arm64 (native) and the offline test on both arm64 and amd64 (amd64 under QEMU). On restart the admin, storage volume, profile, setup state and the work-offline switch survive. After `kill -s KILL` the writer lock is replaced and jobs left `running` return to the queue.

## Known limits

- The renderer and its networks are placeholders (Phase 3, C-16).
- Jobs fail with `No handler named "fetch"` until the fetch handlers land in Phase 2. That is expected.
- The API listens on `0.0.0.0` inside the container, so other containers on `egress` (SearXNG) can reach port 3001 without the proxy secret. No credential is exposed by that, but a later phase should bind the API to the `backend` address only or add a check.
