# Security

How NoConBrain is meant to resist attack, what each container may do, and how secrets are handled. This page is the working record for the hardening phase (H-03); later waves add test results. To report a problem, see [SECURITY.md](../SECURITY.md).

## Threat model in short

NoConBrain is a single-user, self-hosted server. The administrator is trusted. What is not trusted:

- **Archived content.** Pages, stylesheets, scripts and ZIM entries come from the open web. They must never run script in the app's origin, read its cookies or reach the API.
- **Remote servers.** A page, a redirect or a feed can point at an address inside the network. Every outbound request is checked against private ranges.
- **Other containers on a shared network**, such as SearXNG, and anything else that can reach the API port.
- **Other people on the LAN**, when trusted-LAN read-only mode is on.
- **The browser renderer**, which runs untrusted pages in Chromium.

Out of scope: an attacker with administrator access or a shell on the host.

## Isolation design

| Boundary | Mechanism |
|---|---|
| Archived pages vs the app | Pages are served from a separate origin (the archive listener, port 3002) inside a sandboxed frame with a strict Content-Security-Policy, short-lived signed tokens bound to the app origin, and rewritten links. No cookie of the app is ever sent there |
| API vs other containers | The API port is not published. The API refuses any request that neither carries the shared proxy secret (the `web` container adds it) nor comes from inside its own container (the health check). This applies even on a shared Docker network (HB-01, `NCB_API_PROXY_ONLY`, default on). Client addresses and forwarded hosts are trusted only with the secret |
| `web` vs the internet | `web` is on `frontend` (no masquerade) and `backend` (internal). On Linux that leaves it no route out. Docker Desktop for Mac does not honour the masquerade setting; see HB-02 in the hardening backlog |
| Server vs internet | One fetcher with an SSRF guard: scheme, credentials, ports, IP literals in every spelling, and a resolver that is the only way a name becomes an address, so the checked address is the used address |
| Renderer vs everything | The `renderer` container is only on the internal `render` network. Its one way out is the guarded forward proxy that `server` runs. The proxy listens only on the server's address in the `render` subnet (HB-07, `NCB_RENDER_PROXY_HOST` is that subnet), so `web` and `searxng` cannot reach it, and it also needs the renderer secret |
| Fetched pages vs the database | Extraction and PDF parsing run in worker threads with a memory limit; they never touch the database |

## Container capabilities

Every container drops all Linux capabilities (`cap_drop: [ALL]`), sets `no-new-privileges`, has a read-only root file system, small `tmpfs` mounts, memory and process limits, and runs as an unprivileged user.

**The one exception is the renderer, which adds back `CAP_SYS_CHROOT` (HB-08).** Chromium's own sandbox calls `chroot()` as part of setting up its renderer processes. Playwright's seccomp profile (`docker/renderer/seccomp.json`, from `microsoft/playwright`) allows `chroot()` only for a process that holds this capability, and allows the user namespaces Chromium needs. So the renderer gets exactly that capability and nothing else, and Chromium runs with its sandbox on (no `--no-sandbox`). What the capability allows: changing a process's root directory, inside the container's own mount namespace. It does not allow mounting, raw network access, loading kernel modules or any change outside the container. The renderer also has no route to the internet or the LAN, a read-only root and a 1 GiB memory limit. The decision stays under review: if a rootless Chromium sandbox option appears that works under Docker's default seccomp profile, the capability can be removed. A host that forbids unprivileged user namespaces (some hardened Ubuntu settings) stops the renderer from starting; the server then keeps the plain capture.

## Secrets

| Secret | Use | Where it lives |
|---|---|---|
| `NCB_PROXY_SECRET` | Proves a request came from `web`; also the default renderer and SearXNG secrets | `.env`; required in production (at least 16 characters); never logged (header redacted in logs) |
| `NCB_RENDERER_SECRET` | Password the renderer uses at the forward proxy | `.env`, defaults to the proxy secret |
| `NCB_SECRET_KEY` or `/data/secrets/secret.key` | AES-256-GCM key for stored search-provider credentials and the archive token signature | Environment, or a file with mode 0600 generated on first start. Not in backups unless asked for |
| Provider API keys | Brave, Mojeek | Encrypted at rest, never returned by the API, redacted in logs |
| Passwords | Administrator login | scrypt hashes; sessions are random tokens stored hashed |

Losing the secret key means entering provider keys again and signing in again; no archive data is lost.

## Tests behind these claims

- `tests/integration/server/hardening.test.ts`: the API refuses requests without the proxy secret from another container, lets the web app and the health check through, and the renderer proxy binds to one network.
- `tests/integration/renderer/proxy.test.ts`: SSRF checks and the secret on the forward proxy.
- `tests/integration/archive/isolation.test.ts` and the end-to-end suite: archive headers and isolation.
- `tests/reliability`: kill, restart and power-loss behaviour (data safety rather than attack resistance, but it covers the corruption cases).

Results of the full security review (header assertions on all route classes, SSRF fuzzing, XSS corpus, authorisation matrix, dependency audit, SBOM, container review) will be recorded here when H-03 is run.
