# Configuration reference

NoConBrain reads its settings from environment variables, set in `.env` next to `compose.yml`. [.env.example](../.env.example) has every variable with its default and a comment; this page groups them and says what each is for. The code that reads them is `packages/shared/src/config.ts`, and `pnpm docs:check` fails if this page, `.env.example` and the code disagree about which variables exist.

Only `NCB_PROXY_SECRET` is required. Everything else has a default. Changes take effect when the container is recreated: `docker compose up -d`.

Many behaviours are not environment variables at all. Crawl defaults, search ranking, retention, storage thresholds, providers, discovery budgets and privacy switches are settings in the app (Storage and settings), because a person changes them while it runs. They are listed in [api.md](api.md) under Settings.

## Address and ports

| Variable | Default | What it does |
|---|---|---|
| `NCB_APP_URL` | `http://localhost:3000` | The address you type in the browser. Used for cross-site request checks and absolute links. |
| `NCB_WEB_PORT` | `3000` | Port of the app, on the host and in the container. |
| `NCB_ARCHIVE_PORT` | `3002` | Port of the archive listener, on the host and in the container. The browser needs both ports. |
| `NCB_ARCHIVE_PUBLIC_URL` | empty | Where the browser reaches the archive listener when it is not the app's host plus the port above, for example behind a reverse proxy. |
| `NCB_API_PORT` | `3001` | Internal API port. Never published. |
| `NCB_WEB_BIND`, `NCB_ARCHIVE_BIND` | `0.0.0.0` | Which host address each published port binds to (Compose). Use `127.0.0.1` to keep a port off the network. |

## Sign-in and secrets

| Variable | Default | What it does |
|---|---|---|
| `NCB_PROXY_SECRET` | required | Shared secret between `web` and `server`, at least 16 characters. `openssl rand -hex 32`. |
| `NCB_SECRET_KEY` | generated | Encrypts stored provider keys and signs archive tokens. If empty, a key is generated in the data volume on first start. Changing it signs everyone out of archive frames and makes stored provider keys unreadable. |
| `NCB_AUTH_MODE` | `password` | `password` needs a sign-in. `trusted-lan` also lets the networks in `NCB_TRUSTED_LAN_CIDRS` browse and search read-only. It needs an existing administrator. |
| `NCB_TRUSTED_LAN_CIDRS` | empty | Networks for `trusted-lan`, for example `192.168.1.0/24`. |
| `NCB_COOKIE_SECURE` | `false` | Set `true` when you serve over HTTPS. |
| `NCB_TRUST_PROXY`, `NCB_TRUSTED_PROXY_CIDRS` | `false`, empty | Trust forwarded addresses from a reverse proxy you control, and list its range. |
| `NCB_API_PROXY_ONLY` | `true` | The API answers only requests that carry the proxy secret, or that come from inside its own container. |
| `NCB_RATE_LIMIT_PER_MINUTE` | `600` | Requests a minute per client address across the API. |

## Storage

| Variable | Default | What it does |
|---|---|---|
| `NCB_VOLUME_PATH` | `ncb-volume` | Where saved content lives (Compose). A plain name is a Docker volume; a path is a bind mount, writable by user 1000. |
| `NCB_VOLUMES_ALLOWED_ROOTS` | `/volumes` | Folders in the container that may be registered as storage or used for knowledge packages. Comma separated. |
| `NCB_MIN_FREE_DISK_GB` | `5` | Downloads pause when free space on a volume falls below this. |
| `NCB_DATA_DIR` | `/data` | Databases, secrets, temporary files and backups. |
| `NCB_IMPORT_MAX_MB` | `50` | Largest document the import accepts. |

## Resources

| Variable | Default | What it does |
|---|---|---|
| `NCB_RESOURCE_PROFILE` | `pi-lite` on arm64, else `standard` | Preset for the group below. |
| `NCB_MAX_FETCH_CONCURRENCY` | `2` | Fetches at once. |
| `NCB_PER_HOST_CONCURRENCY` | `1` | Fetches at once to one site. |
| `NCB_EXTRACT_WORKERS` | `1` | Threads that extract readable text. `0` turns extraction off. |
| `NCB_WORKER_MEMORY_MB` | `256` | Heap limit for each extraction worker. |
| `NCB_SERVER_MEMORY`, `NCB_SERVER_CPUS`, `NCB_WEB_MEMORY` | `768m`, `2.0`, `384m` | Container limits (Compose). |
| `NCB_ZIM_CACHE_MB` | `16` | Cache for each open knowledge package. |
| `NCB_ZIM_SEARCH_BUDGET_MS` | `800` | Time one package may take in a combined search. |

## Crawling and online access

| Variable | Default | What it does |
|---|---|---|
| `NCB_CONTACT` | empty | An email address or web page added to the `User-Agent`. Required for any Wikipedia request. |
| `NCB_CONNECTIVITY_PROBE_URL` | empty | An address requested now and then to learn whether the internet is reachable. Empty means no probe. |
| `NCB_FETCH_ALLOW_PRIVATE_HOSTS` | empty | Hosts the server may fetch although they are on a private network, for crawling your own LAN on purpose. Comma separated `host`, `host:port`, `*.suffix`, an address or a CIDR. Empty refuses every private address. Read by the fetcher directly. |
| `NCB_DISCOVERY_PASS_SECONDS` | `30` | Seconds between Discovery passes. `0` turns the timer off. |
| `NCB_WIKIPEDIA_ORIGIN` | empty | Replaces `https://<language>.wikipedia.org`. For a mirror or for tests; the pace and contact rules still apply. Not in `.env.example`. |

## Logging, schedules and maintenance

| Variable | Default | What it does |
|---|---|---|
| `NCB_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. |
| `NCB_LOG_FORMAT` | `json` | `json` or `pretty`. |
| `NCB_ACTIVITY_LOG_RETENTION_DAYS` | `30` | How long the activity log is kept. |
| `NCB_SHUTDOWN_GRACE_SECONDS` | `25` | Time given to running work to reach a safe point on stop. |
| `NCB_TZ` | `UTC` | Time zone for schedules and download windows. |
| `NCB_SCHEDULER_ENABLED` | `true` | Run scheduled sources. |
| `NCB_BACKUP_INTERVAL_HOURS` | `24` | Hours between database backups. `0` turns them off. |
| `NCB_BACKUP_KEEP` | `7` | Finished backups kept. |
| `NCB_BACKUP_INCLUDE_INDEX` | `false` | Include the search index in scheduled backups. |
| `NCB_VERIFY_INTERVAL_HOURS` | `168` | Hours between full read-only verifies. `0` turns them off. |
| `NCB_JOB_RETENTION_DAYS` | `7` | Finished jobs older than this are rolled into daily counters. `0` keeps them. |

## Optional services

| Variable | Default | What it does |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `nocon-brain` | Prefix for container, network and volume names. |
| `NCB_VERSION` | `latest` | Image tag. |
| `NCB_REGISTRY` | empty | Registry prefix with a trailing slash, for example `ghcr.io/slaterjohn/`. Empty builds from the folder. |
| `COMPOSE_PROFILES` | empty | `searxng`, `renderer`, or both separated by a comma. |
| `NCB_SEARXNG_VERSION`, `NCB_SEARXNG_MEMORY`, `NCB_SEARXNG_SECRET` | `latest`, `384m`, the proxy secret | The SearXNG container. |
| `NCB_RENDERER_URL` | empty | Where the renderer listens (`http://renderer:8080`). Empty means no rendering. |
| `NCB_RENDERER_SECRET` | the proxy secret | Shared by `server` and `renderer`. |
| `NCB_RENDER_PROXY_PORT` | `3128` | Port of the guarded forward proxy the renderer must use. |
| `NCB_RENDER_CONCURRENCY` | `1` | Pages rendered at once. |
| `NCB_RENDER_TIMEOUT_SECONDS` | `45` | Time allowed for one page. |
| `NCB_RENDER_NEVER_HOSTS` | empty | Hosts that are never rendered, exact or `*.suffix`. |
| `NCB_RENDERER_MEMORY`, `NCB_RENDERER_CPUS`, `NCB_RENDERER_RESTART_AFTER_PAGES` | `1g`, `2.0`, `50` | Renderer container limits and how often the browser restarts. |
| `NCB_BACKEND_SUBNET`, `NCB_RENDER_SUBNET` | `172.31.249.0/24`, `172.31.250.0/24` | Fixed subnets of the internal networks. Change them only if they clash with one you use. |
