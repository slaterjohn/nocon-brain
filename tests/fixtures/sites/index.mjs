#!/usr/bin/env node
// Deterministic fixture websites for NoConBrain tests. Plain Node ESM, built-in modules only.
//   import { startFixtures } from './tests/fixtures/sites/index.mjs';
//   const fx = await startFixtures();  fx.urls.article ...  await fx.close();
//   CLI:  node tests/fixtures/sites/index.mjs   (prints URLs, runs until Ctrl-C)
import { fileURLToPath } from 'node:url';
import { startArticle } from './article.mjs';
import { startLinkGraph } from './linkgraph.mjs';
import { startTrap } from './trap.mjs';
import { startRobots } from './robots.mjs';
import { startEdge } from './edge.mjs';
import { startSsrfBait } from './ssrf.mjs';
import { startWikipedia } from './wikipedia.mjs';
import { startSearxng, startBrave, startMojeek, BRAVE_TOKEN, MOJEEK_KEY } from './providers.mjs';
import { startSitemapFeed } from './sitemap.mjs';

/**
 * @param {object} [opts]
 * @param {string} [opts.appApiUrl]   URL the malicious article page tries to fetch (default http://127.0.0.1:3000/api/evil-probe)
 * @param {number} [opts.edgeSlowMs]  default delay of edge /slow (default 2000)
 * @param {number} [opts.wikiRps]     wikipediaLike requests per second before 429 (default 5)
 * @param {number} [opts.robotsTimeoutMs] how long the robotsTimeout instance hangs on robots.txt (default 30000)
 */
export async function startFixtures(opts = {}) {
  const ctx = { urls: {} };
  const sites = {};
  const starters = {
    article: () => startArticle({ appApiUrl: opts.appApiUrl }),
    linkGraph: () => startLinkGraph(ctx),
    trap: () => startTrap(),
    robots: () => startRobots('main'),
    robots404: () => startRobots('404'),
    robots500: () => startRobots('500'),
    robotsRedirect: () => startRobots('redirect'),
    robotsTimeout: () => startRobots('timeout', { timeoutMs: opts.robotsTimeoutMs }),
    edge: () => startEdge(ctx, { slowMs: opts.edgeSlowMs }),
    ssrfBait: () => startSsrfBait(),
    wikipediaLike: () => startWikipedia({ rps: opts.wikiRps }),
    searxng: () => startSearxng(ctx),
    brave: () => startBrave(ctx),
    mojeek: () => startMojeek(ctx),
    sitemapFeed: () => startSitemapFeed(ctx),
  };
  try {
    await Promise.all(Object.entries(starters).map(async ([k, f]) => {
      sites[k] = await f();
      ctx.urls[k] = sites[k].origin;
    }));
  } catch (err) {
    await Promise.allSettled(Object.values(sites).map((s) => s.close()));
    throw err;
  }
  // Stable key order for printing.
  const urls = Object.fromEntries(Object.keys(starters).map((k) => [k, ctx.urls[k]]));
  Object.assign(ctx.urls, urls);
  return {
    urls,
    sites,
    credentials: { braveToken: BRAVE_TOKEN, mojeekApiKey: MOJEEK_KEY },
    /** Request log of a site as seen by its /__log endpoint, without HTTP. */
    log: (name) => sites[name].state,
    async close() {
      await Promise.allSettled(Object.values(sites).map((s) => s.close()));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fx = await startFixtures();
  console.log('NoConBrain fixture sites (Ctrl-C to stop)\n');
  for (const [k, v] of Object.entries(fx.urls)) console.log(`${k.padEnd(16)} ${v}`);
  console.log(`\nBrave token: ${fx.credentials.braveToken}   Mojeek key: ${fx.credentials.mojeekApiKey}`);
  console.log('Every site: /__health  /__log  /__log/reset.  See tests/fixtures/sites/README.md.');
  const stop = async () => {
    await fx.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
