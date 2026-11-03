# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (a private security advisory). Please do not open a public issue or pull request for a security problem.

Include what you found, the version or commit, how to reproduce it, and the impact you expect. NoConBrain is a small project run on a best-effort basis, so there's no fixed time for a reply or a fix. Reports are read, and confirmed security issues come before other work.

## Supported versions

Only the latest release and the latest commit on `main` are supported (the current version is 1.0.0-rc.1). There are no maintained release branches. Security fixes are listed in [CHANGELOG.md](CHANGELOG.md).

## In scope

- Authentication and sessions, including the first-run setup and the trusted-LAN option.
- Escaping the archive listener's isolation: archived pages or ZIM entries that run script, reach the main app's origin, or read its cookies.
- Server-side request forgery through crawls, captures, imports or search providers, including redirects to private addresses.
- Path traversal, or reading and writing files outside the data folder and the allowed volume roots.
- Leaks of stored search-provider credentials, or of search text the privacy settings say is not kept.
- Storage actions that delete Protected (P1) content, or anything else, without the confirmation the app promises.
- Container hardening problems in `compose.yml` or the Dockerfiles.

## Out of scope

- Problems that need an attacker who already has administrator access, or shell access to the host.
- Findings that only apply when the deployment advice below is ignored, such as publishing the ports to the internet with no proxy.
- Denial of service by an authenticated user against their own server.
- Vulnerabilities in Chromium, libzim, SQLite, SearXNG or Docker themselves. Report those upstream.
- Missing security headers or best-practice suggestions with no demonstrated impact.

## Deployment advice

NoConBrain is built for one household on a trusted network.

- Run it on your LAN or behind Tailscale. That is the supported setup.
- Do not expose the web port (3000) or the archive port (3002) directly to the internet. If you need remote access, put a reverse proxy with HTTPS in front and bind the ports to `127.0.0.1` with `NCB_WEB_BIND` and `NCB_ARCHIVE_BIND`. The archive port must stay on its own origin, so give it its own hostname rather than a path on the main one.
- Use long random values for `NCB_PROXY_SECRET` and the other secrets, and keep `.env` readable only by you (`chmod 600 .env`).
- `NCB_SECRET_KEY` encrypts stored search-provider credentials. If you don't set it, a key is generated in the data folder's `secrets` directory. Either way, back it up with your data, or the credentials have to be entered again.
- Only set `NCB_VOLUMES_ALLOWED_ROOTS` to folders NoConBrain should be able to write to.

Step-by-step setup, including HTTPS behind a reverse proxy, is in [docs/guides/install.md](docs/guides/install.md). The design is described in [docs/architecture.md](docs/architecture.md) and the deployment options in [docs/deployment.md](docs/deployment.md).
