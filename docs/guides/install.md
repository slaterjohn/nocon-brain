# Install

NoConBrain runs as Docker Compose services: `web` (the app), `server` (the API, the archive listener and the background jobs) and, if you ask for them, `searxng` and `renderer`. It needs Docker with Compose v2 and about 1 GB of free memory for `web` and `server` together.

This guide covers a first install on a PC or server, the extra care a Raspberry Pi needs, and putting the app behind a reverse proxy with HTTPS. To move to a newer version, see [upgrade.md](upgrade.md). If something does not start, see [troubleshooting.md](troubleshooting.md).

## Install with Docker Compose

1. Get the files and make a settings file.

   ```sh
   git clone https://github.com/slaterjohn/nocon-brain.git
   cd nocon-brain
   cp .env.example .env
   sed -i.bak "s/^NCB_PROXY_SECRET=.*/NCB_PROXY_SECRET=$(openssl rand -hex 32)/" .env && rm .env.bak
   chmod 600 .env
   ```

   `NCB_PROXY_SECRET` is the only required setting. It is a shared secret between `web` and `server`. Compose refuses to start without it.

2. Start the stack.

   ```sh
   docker compose up -d --wait
   ```

   The first run builds the images from the source in the folder. That takes a few minutes on a PC and longer on a Pi. To pull published images instead of building, set `NCB_REGISTRY=ghcr.io/slaterjohn/` and `NCB_VERSION=<version>` in `.env` first and run `docker compose pull`. Images are published only for tagged releases; check the [releases page](https://github.com/slaterjohn/nocon-brain/releases) before relying on this.

3. Open <http://localhost:3000>. The setup wizard asks for an administrator, a storage location, a resource profile, optional search providers and a first source.

If you use another host name or port, set `NCB_APP_URL` in `.env` to the address you type in the browser, then run `docker compose up -d` again. The app checks the address of every request against it, so a mismatch shows up as "This request came from a different website than the app".

Archived pages are served from a second port, `NCB_ARCHIVE_PORT` (3002). The browser loads them directly from that port, so keep it reachable from every machine that uses the app. It is a separate origin on purpose: it keeps saved pages away from the app and its sign-in cookie.

### Where the data lives

| What | Default | Change it with |
|---|---|---|
| Databases, secrets, backups | Docker volume `ncb-data`, mounted at `/data` | Not meant to move |
| Saved pages, images, knowledge packages | Docker volume `ncb-volume`, mounted at `/volumes/default` | `NCB_VOLUME_PATH=/mnt/ssd/noconbrain` |

For a path on the host, create it first and give it to user 1000, because the containers do not run as root:

```sh
sudo mkdir -p /mnt/ssd/noconbrain && sudo chown 1000:1000 /mnt/ssd/noconbrain
```

Downloads pause when free space on a volume falls below `NCB_MIN_FREE_DISK_GB` (default 5).

### Optional services

- Self-hosted search: `docker compose --profile searxng up -d --wait`, then add a SearXNG provider with the address `http://searxng:8080`. See [privacy-and-providers.md](privacy-and-providers.md).
- Renderer for pages that are empty until their scripts run: put `COMPOSE_PROFILES=renderer` and `NCB_RENDERER_URL=http://renderer:8080` in `.env`. Both lines are needed. It uses about 130 MB idle and 80 MB or more for each page it renders ([benchmarks.md](../benchmarks.md)).

## Raspberry Pi

NoConBrain targets the Raspberry Pi 4 and 5 with a 64-bit operating system. **It has not been run on one.** The images build for arm64 and the test suites pass on arm64 CI runners, but no Pi was available to try it, so the notes below come from the design and from an Apple Silicon Mac, not from experience. If you try it, please report what you find. Figures for a Pi in [benchmarks.md](../benchmarks.md) are marked "not measured".

- Use Raspberry Pi OS (64-bit) or Ubuntu Server (64-bit), and install Docker from Docker's own repository rather than the distribution's, so that you get Compose v2.
- Keep the archive on an SSD, not the SD card. Set `NCB_VOLUME_PATH` to a folder on the SSD. SQLite and thousands of small files wear an SD card quickly. Put `/data` on the SSD too if you can (a bind mount in `compose.yml` in place of `ncb-data`).
- Use a Pi 4 or 5 with at least 4 GB. The default limits (`NCB_SERVER_MEMORY=768m`, `NCB_WEB_MEMORY=384m`) leave room for the system. On ARM64 the resource profile defaults to `pi-lite`: one extraction worker, two fetches at a time, one per host.
- Building images on a Pi is slow. If published images exist for your version, use them (`NCB_REGISTRY`, above).
- Searching a large library while it is being indexed is where a Pi is most likely to struggle. [benchmarks.md](../benchmarks.md) shows what a large library costs in memory on a fast machine; plan for the same shape of cost, several times slower.
- The Pi has no battery-backed clock. If the time is wrong when it starts, schedules and download windows are wrong until it syncs. Enable time sync (`timedatectl set-ntp true`).
- Set `NCB_TZ` to your time zone (default `UTC`) so that schedules and download windows run when you expect.

## Behind a reverse proxy with HTTPS

Run NoConBrain on your LAN or behind a VPN such as Tailscale if you can. If you must reach it over the internet, put a reverse proxy with HTTPS in front. **The proxy example below has not been tested here with every proxy.** It shows the settings that matter.

Use two host names, because archived pages must stay on a different origin from the app:

| Host name | Proxies to | Purpose |
|---|---|---|
| `brain.example.org` | `127.0.0.1:3000` | The app |
| `archive.example.org` | `127.0.0.1:3002` | Archived pages |

`.env`:

```sh
NCB_APP_URL=https://brain.example.org
NCB_ARCHIVE_PUBLIC_URL=https://archive.example.org
NCB_COOKIE_SECURE=true
# Only when the proxy runs on another machine or container; list its address range.
NCB_TRUST_PROXY=true
NCB_TRUSTED_PROXY_CIDRS=192.168.1.10/32
# Keep the published ports off the network, so only the proxy can reach them.
NCB_WEB_BIND=127.0.0.1
NCB_ARCHIVE_BIND=127.0.0.1
```

Caddy:

```
brain.example.org {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
archive.example.org {
    reverse_proxy 127.0.0.1:3002
}
```

With nginx, add `proxy_buffering off;` and `proxy_read_timeout 1h;` to the app's `location` block. Search results arrive as a server-sent event stream and appear all at once, late, if the proxy buffers them.

Do not put the app and the archive on one host name with different paths. The archive listener refuses to work that way, and the isolation depends on the separate origin.

Add your own sign-in protection in the proxy if the app is on the open internet. NoConBrain has one administrator account with a password, sign-in rate limits and CSRF checks, but it is built for one household, not for the open internet ([SECURITY.md](../../SECURITY.md)).

## Check that it works

1. `docker compose ps` shows `server` and `web` as healthy.
2. In the app, open Storage and settings, then Check and repair, and run a check. A new install should report no problems.
3. Save a page from the Browser, switch **Work offline** on, and open the page again.
