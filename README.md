# NoConBrain

NoConBrain is a self-hosted, offline-first knowledge archiver, crawler and search engine. It is part of the NoCon family, alongside NoConMedia. It archives web pages and sites to your own storage, lets you browse and search them with no internet connection, and can blend in results from online search providers when a connection is available.

**Status: planning.** There is no application code yet. The planning documents are in [docs/](docs/README.md): architecture, technology decisions, data model, API, implementation plan and risk register. The research behind them is in [docs/research/](docs/research/).

Target platforms are Docker Compose on Raspberry Pi 4/5 (ARM64) and AMD64 servers.

## Run with Docker

You need Docker with Compose v2. The images build for ARM64 (Raspberry Pi 4 and 5) and AMD64.

```
git clone https://github.com/slaterjohn/nocon-brain.git
cd nocon-brain
cp .env.example .env
sed -i.bak "s/^NCB_PROXY_SECRET=.*/NCB_PROXY_SECRET=$(openssl rand -hex 32)/" .env && rm .env.bak
docker compose up -d --wait
```

Open <http://localhost:3000> and follow the setup steps. The first start builds the images, which takes a few minutes on a Pi.

If you use another host name or port, set `NCB_APP_URL` in `.env` to the address you type in the browser. Archived pages are served from port 3002, so keep that port reachable too. To keep archived content on a separate drive, set `NCB_VOLUME_PATH` (see `.env.example`). Optional self-hosted search: `docker compose --profile searxng up -d --wait`. Deployment details are in [docs/deployment.md](docs/deployment.md).

## Development

Requires Node 24 or later (`.nvmrc`) and pnpm 10 (`corepack enable`). `better-sqlite3` ships prebuilt binaries per Node ABI; on an older Node it can crash on load, so run `pnpm install` (or `pnpm rebuild better-sqlite3`) under Node 24.

```
pnpm install
pnpm typecheck
pnpm test                 # unit
pnpm test:integration     # real SQLite, worker threads
node scripts/licence-audit.mjs
```

## Licence

NoConBrain is licensed under the GNU Affero General Public Licence, version 3 (AGPL-3.0). See [LICENSE](LICENSE).
