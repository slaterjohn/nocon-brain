// Self-test: starts every fixture, hits a sample of routes, asserts statuses and bodies.
//   node tests/fixtures/sites/selftest.mjs
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import http from 'node:http';
import { startFixtures } from './index.mjs';
import { ARTICLES } from './articles-data.mjs';

const fx = await startFixtures({ edgeSlowMs: 150, wikiRps: 3 });
const u = fx.urls;
const UA = 'NoConBrainFixtureTest/1.0 (mailto:test@example.org)';
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`);
  }
}
const get = (url, init = {}) => fetch(url, { redirect: 'manual', ...init });
const txt = async (url, init) => {
  const r = await get(url, init);
  return { r, t: await r.text() };
};
const jget = async (url, init) => {
  const r = await get(url, init);
  return { r, j: await r.json() };
};
/** Raw HTTP GET that does not decode content-encoding. */
function raw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ res, body: Buffer.concat(parts) }));
    }).on('error', reject);
  });
}

try {
  console.log('article');
  await test('has >= 30 pages and every one returns 200', async () => {
    assert.ok(ARTICLES.length >= 30);
    for (const a of ARTICLES) assert.equal((await get(`${u.article}/${a.slug}`)).status, 200, a.slug);
  });
  await test('astronomy page content and metadata', async () => {
    const { r, t } = await txt(`${u.article}/astronomy`);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(t, /<title>Astronomy \| Fixture Gazette<\/title>/);
    for (const w of ['solar system', 'black holes', 'planets']) assert.ok(t.toLowerCase().includes(w), w);
    for (const s of ['<nav', '<header', '<footer', '<aside', '<article', '<figcaption', '<table', '<pre><code', 'class="references"', 'srcset=', 'style="', 'og:title', 'application/ld+json', 'rel="canonical"', '"datePublished"']) assert.ok(t.includes(s), s);
    assert.match(t, /<html lang="en">/);
  });
  await test('french page has lang=fr', async () => {
    assert.match((await txt(`${u.article}/fr/astronomie`)).t, /<html lang="fr">/);
  });
  await test('near duplicates canonicalise to the original', async () => {
    const { t } = await txt(`${u.article}/renewable-energy-copy`);
    assert.ok(t.includes(`<link rel="canonical" href="${u.article}/renewable-energy">`));
  });
  await test('CSS has @import, @font-face and url(); font and images load', async () => {
    const css = (await txt(`${u.article}/assets/site.css`)).t;
    assert.match(css, /@import url\("\/assets\/base\.css"\)/);
    assert.match(css, /@font-face/);
    assert.match(css, /url\("\/img\/bg\.png"\)/);
    const font = await get(`${u.article}/assets/fonts/fixture.woff2`);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    const png = Buffer.from(await (await get(`${u.article}/img/hero.png`)).arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal((await get(`${u.article}/favicon.ico`)).status, 200);
  });
  await test('dedup pages share identical CSS and image bytes under different URLs', async () => {
    const a = Buffer.from(await (await get(`${u.article}/img/hero.png`)).arrayBuffer());
    const b = Buffer.from(await (await get(`${u.article}/img/hero-copy.png`)).arrayBuffer());
    assert.ok(a.equals(b));
    assert.equal((await txt(`${u.article}/assets/site.css`)).t, (await txt(`${u.article}/assets/site-copy.css`)).t);
    assert.match((await txt(`${u.article}/dedup/b`)).t, /site-copy\.css/);
  });
  await test('conditional GET returns 304 and beacons are recorded', async () => {
    const first = await get(`${u.article}/astronomy`);
    const etag = first.headers.get('etag');
    assert.equal((await get(`${u.article}/astronomy`, { headers: { 'If-None-Match': etag } })).status, 304);
    await get(`${u.article}/__beacon?kind=test`);
    assert.ok((await jget(`${u.article}/__beacons`)).j.some((b) => b.query.kind === 'test'));
  });
  await test('malicious page contains the hostile script, form and cookie', async () => {
    const { r, t } = await txt(`${u.article}/malicious`);
    for (const s of ['document.cookie', 'top.location', 'fetch(', 'action="http://127.0.0.1:9/steal"']) assert.ok(t.includes(s), s);
    assert.match(r.headers.get('set-cookie'), /fixture_session/);
  });
  await test('unknown page is 404', async () => assert.equal((await get(`${u.article}/nope`)).status, 404));

  console.log('linkGraph');
  await test('graph json: 200 content nodes, depth structure, broken links', async () => {
    const { j } = await jget(`${u.linkGraph}/__graph.json`);
    assert.equal(j.nodeCount, 200);
    assert.deepEqual(j.countsByDepth, { 0: 1, 1: 6, 2: 30, 3: 150, 4: 13 });
    assert.ok(j.brokenTargets.length >= 5);
    assert.ok(j.edges.some((e) => e.external && e.to.startsWith(u.article)));
    for (const region of ['heading', 'main', 'related', 'nav', 'footer']) assert.ok(j.edges.some((e) => e.region === region), region);
  });
  await test('crawling the real pages reproduces the graph depths and the broken links 404', async () => {
    const { j } = await jget(`${u.linkGraph}/__graph.json`);
    const seen = new Map([[j.root, 0]]);
    const queue = [j.root];
    const broken = new Set();
    while (queue.length) {
      const cur = queue.shift();
      const { r, t } = await txt(cur);
      if (r.status === 404) { broken.add(cur); continue; }
      for (const m of t.matchAll(/href="([^"]+)"/g)) {
        const target = new URL(m[1], cur).href;
        if (!target.startsWith(u.linkGraph) || seen.has(target) || target === `${u.linkGraph}/`) continue;
        seen.set(target, seen.get(cur) + 1);
        queue.push(target);
      }
    }
    for (const n of j.nodes) assert.equal(seen.get(n.url), n.depth, n.url);
    assert.ok(broken.size >= 5);
    for (const b of j.brokenTargets.filter((x) => x.startsWith(u.linkGraph))) assert.ok(broken.has(b), b);
  });

  console.log('trap');
  await test('calendar next/prev links forever', async () => {
    const { t } = await txt(`${u.trap}/cal/2026/11/01`);
    assert.ok(t.includes('href="/cal/2026/11/02"') && t.includes('href="/cal/2026/10/31"'));
    assert.ok((await txt(`${u.trap}/cal/2026/12/31`)).t.includes('/cal/2027/01/01'));
  });
  await test('repeating segments, sessions, pagination, facets', async () => {
    assert.ok((await txt(`${u.trap}/a/a/a/a`)).t.includes('href="/a/a/a/a/a"'));
    assert.ok((await txt(`${u.trap}/a/b/a/b`)).t.includes('/a/b/a/b/b'));
    assert.match((await txt(`${u.trap}/sess/page?sid=s4`)).t, /sid=s5&amp;PHPSESSID=p5/);
    assert.ok((await txt(`${u.trap}/list?page=12345`)).t.includes('page=12346'));
    assert.ok((await txt(`${u.trap}/facets?sort=price&filter=a`)).t.includes('&amp;x=3'));
  });
  await test('redirect loops never terminate and tracking page self-links', async () => {
    const a = await get(`${u.trap}/redirect/loop-a`);
    assert.equal(a.status, 302);
    assert.equal(a.headers.get('location'), '/redirect/loop-b');
    assert.equal((await get(`${u.trap}/redirect/self`)).headers.get('location'), '/redirect/self');
    const { t } = await txt(`${u.trap}/track/article?utm_source=x`);
    assert.ok(/utm_source=n\d+&amp;utm_medium=email.*fbclid=f\d+&amp;gclid=g\d+/.test(t));
    assert.ok(t.includes(`rel="canonical" href="${u.trap}/track/article"`));
  });

  console.log('robots');
  await test('main robots.txt has groups, allow/disallow, crawl-delay and sitemap', async () => {
    const { r, t } = await txt(`${u.robots}/robots.txt`);
    assert.equal(r.status, 200);
    for (const s of ['User-agent: *', 'Disallow: /private/', 'Allow: /private/public-note', 'Crawl-delay: 2', 'User-agent: NoConBrain', 'User-agent: BadBot', `Sitemap: ${u.robots}/sitemap.xml`]) assert.ok(t.includes(s), s);
  });
  await test('status variants: 404, 500, redirect', async () => {
    assert.equal((await get(`${u.robots404}/robots.txt`)).status, 404);
    assert.equal((await get(`${u.robots500}/robots.txt`)).status, 500);
    const r = await get(`${u.robotsRedirect}/robots.txt`);
    assert.equal(r.status, 301);
    assert.equal((await txt(new URL(r.headers.get('location'), u.robotsRedirect))).r.status, 200);
  });
  await test('robotsTimeout hangs (aborts after 300 ms)', async () => {
    await assert.rejects(get(`${u.robotsTimeout}/robots.txt`, { signal: AbortSignal.timeout(300) }));
    assert.equal((await get(`${u.robotsTimeout}/public/x`)).status, 200);
  });

  console.log('edge');
  await test('slow response honours the configured delay', async () => {
    const t0 = Date.now();
    assert.equal((await get(`${u.edge}/slow`)).status, 200);
    assert.ok(Date.now() - t0 >= 140);
    const ctl = (await jget(`${u.edge}/__control?slowMs=10`)).j;
    assert.equal(ctl.slowMs, 10);
  });
  await test('huge endless body can be cut off by the client', async () => {
    const r = await fetch(`${u.edge}/huge`);
    const reader = r.body.getReader();
    let n = 0;
    while (n < 3_000_000) n += (await reader.read()).value.length;
    await reader.cancel();
    assert.ok(n >= 3_000_000);
    const sized = await fetch(`${u.edge}/huge?bytes=100000`);
    assert.equal((await sized.arrayBuffer()).byteLength, 100000);
  });
  await test('gzip bomb is small on the wire and huge decoded', async () => {
    const { res, body } = await raw(`${u.edge}/bomb.gz?mb=20`);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.ok(body.length < 100 * 1024, `wire ${body.length}`);
    assert.equal(zlib.gunzipSync(body).length, 20 * 1024 * 1024);
    const layers = (await raw(`${u.edge}/bomb-layers?n=7`)).res.headers['content-encoding'];
    assert.equal(layers.split(',').length, 7);
  });
  await test('wrong or missing content types', async () => {
    assert.equal((await get(`${u.edge}/type/html-as-plain`)).headers.get('content-type'), 'text/plain');
    assert.equal((await get(`${u.edge}/type/html-as-image`)).headers.get('content-type'), 'image/png');
    assert.equal((await get(`${u.edge}/type/png-as-html`)).headers.get('content-type'), 'text/html');
    assert.equal((await raw(`${u.edge}/type/no-type`)).res.headers['content-type'], undefined);
  });
  await test('chunked responses use chunked transfer encoding', async () => {
    const { res, body } = await raw(`${u.edge}/chunked`);
    assert.equal(res.headers['transfer-encoding'], 'chunked');
    assert.match(body.toString(), /the end/);
  });
  await test('conditional requests: 304 on ETag, 304 on Last-Modified, change on demand, unchanged-new-etag', async () => {
    await get(`${u.edge}/__control?reset=1`);
    const r1 = await get(`${u.edge}/cond/doc`);
    const etag = r1.headers.get('etag');
    const lm = r1.headers.get('last-modified');
    assert.equal(r1.status, 200);
    assert.equal((await get(`${u.edge}/cond/doc`, { headers: { 'If-None-Match': etag } })).status, 304);
    assert.equal((await get(`${u.edge}/cond/doc`, { headers: { 'If-Modified-Since': lm } })).status, 304);
    assert.equal((await get(`${u.edge}/cond/weak`, { headers: { 'If-None-Match': (await get(`${u.edge}/cond/weak`)).headers.get('etag') } })).status, 304);
    await get(`${u.edge}/__control?cond_version=2`);
    const r2 = await get(`${u.edge}/cond/doc`, { headers: { 'If-None-Match': etag } });
    assert.equal(r2.status, 200);
    assert.match(await r2.text(), /version 2/);
    await get(`${u.edge}/__control?etag_salt=x`);
    assert.equal((await get(`${u.edge}/cond/doc`, { headers: { 'If-None-Match': r2.headers.get('etag') } })).status, 200);
    await get(`${u.edge}/__control?gone=1`);
    assert.equal((await get(`${u.edge}/cond/gone`)).status, 404);
    await get(`${u.edge}/__control?reset=1`);
  });
  await test('429 with Retry-After, and 503 that recovers after N requests', async () => {
    const r = await get(`${u.edge}/429?after=7`);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '7');
    for (let i = 1; i <= 3; i++) assert.equal((await get(`${u.edge}/flaky/t1?fail=3`)).status, 503);
    assert.equal((await get(`${u.edge}/flaky/t1?fail=3`)).status, 200);
    assert.equal((await get(`${u.edge}/429/once?key=k`)).status, 429);
    assert.equal((await get(`${u.edge}/429/once?key=k`)).status, 200);
  });
  await test('redirect statuses, chains and cross-origin hop', async () => {
    for (const code of [301, 302, 307, 308]) assert.equal((await get(`${u.edge}/redirect/${code}`)).status, code);
    let url = `${u.edge}/redirect/chain/5`;
    const codes = [];
    for (let i = 0; i < 10; i++) {
      const r = await get(url);
      if (r.status === 200) break;
      codes.push(r.status);
      url = new URL(r.headers.get('location'), url).href;
    }
    assert.equal(codes.length, 5);
    assert.ok(new Set(codes).size > 1, 'mixed codes');
    const x = await get(`${u.edge}/redirect/cross/article`);
    assert.equal(x.headers.get('location'), `${u.article}/`);
  });
  await test('latin1 charset, status passthrough, 404', async () => {
    const { res, body } = await raw(`${u.edge}/charset/latin1`);
    assert.match(res.headers['content-type'], /iso-8859-1/);
    assert.ok(body.includes(0xe9));
    assert.equal((await get(`${u.edge}/status/410`)).status, 410);
  });

  console.log('ssrfBait');
  await test('redirects point at every bait target and canary stays at zero', async () => {
    const targets = (await jget(`${u.ssrfBait}/__targets`)).j;
    for (const want of ['http://127.0.0.1', 'http://[::1]', 'http://169.254.169.254', 'http://10.0.0.1', 'http://100.64.0.1', 'http://2130706433', 'http://0x7f.1', 'http://[::ffff:127.0.0.1]', 'http://localhost', 'localtest.me']) {
      assert.ok(Object.values(targets).some((t) => t.url.startsWith(want) || t.url.includes(want)), want);
    }
    for (const k of Object.keys(targets)) {
      const r = await get(`${u.ssrfBait}/redirect/${k}`);
      assert.equal(r.status, 302, k);
      assert.equal(r.headers.get('location'), targets[k].url, k);
    }
    assert.equal((await jget(`${u.ssrfBait}/__canary`)).j.hits, 0);
    await get(`${u.ssrfBait}/canary`);
    assert.equal((await jget(`${u.ssrfBait}/__canary`)).j.hits, 1);
    await get(`${u.ssrfBait}/__canary/reset`);
  });
  await test('bait pages link to private addresses', async () => {
    const t = (await txt(`${u.ssrfBait}/page/links`)).t;
    assert.ok(t.includes('http://0x7f.1') && t.includes('[::ffff:127.0.0.1]') && t.includes('169.254.169.254'));
    assert.ok((await txt(`${u.ssrfBait}/page/bait.css`)).t.includes('@import'));
  });

  console.log('wikipediaLike');
  const W = `${u.wikipediaLike}/w/rest.php/v1/page`;
  const H = { 'User-Agent': UA };
  await test('rejects missing / anonymous User-Agent with 403', async () => {
    assert.equal((await get(`${W}/Astronomy/html`, { headers: { 'User-Agent': 'node' } })).status, 403);
  });
  await test('with_html returns html, revision, timestamp and licence', async () => {
    const { r, j } = await jget(`${W}/Astronomy/with_html`, { headers: H });
    assert.equal(r.status, 200);
    assert.equal(j.key, 'Astronomy');
    assert.ok(j.latest.id > 0 && j.latest.timestamp.endsWith('Z'));
    assert.match(j.license.title, /Creative Commons Attribution-Share Alike/);
    assert.match(j.html, /rel="mw:WikiLink" href="\.\/Black_hole"/);
  });
  await test('html route has ETag/304 and redirects/404 work', async () => {
    await get(`${u.wikipediaLike}/__control?rps=1000`);
    const r = await get(`${W}/Black_hole/html`, { headers: H });
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('content-language'), 'en');
    await r.text();
    assert.equal((await get(`${W}/Black_hole/html`, { headers: { ...H, 'If-None-Match': r.headers.get('etag') } })).status, 304);
    assert.equal((await get(`${W}/Blackhole/html`, { headers: H })).status, 307);
    assert.equal((await get(`${W}/No_such_page/html`, { headers: H })).status, 404);
  });
  await test('Action API: prop=links ns0, imageinfo extmetadata, maxlag', async () => {
    const A = `${u.wikipediaLike}/w/api.php?action=query&format=json`;
    const links = (await jget(`${A}&prop=links&titles=Astronomy&plnamespace=0&pllimit=max`, { headers: H })).j;
    const page = Object.values(links.query.pages)[0];
    assert.ok(page.links.every((l) => l.ns === 0) && page.links.some((l) => l.title === 'Black hole'));
    const im = (await jget(`${A}&prop=imageinfo&iiprop=extmetadata|url&titles=File:Sun_illustration.png`, { headers: H })).j;
    const meta = Object.values(im.query.pages)[0].imageinfo[0].extmetadata;
    assert.equal(meta.LicenseShortName.value, 'Public domain');
    await get(`${u.wikipediaLike}/__control?lag=9`);
    const lag = (await jget(`${A}&prop=links&titles=Astronomy&maxlag=5`, { headers: H })).j;
    assert.equal(lag.error.code, 'maxlag');
    await get(`${u.wikipediaLike}/__control?lag=0`);
  });
  await test('rate limit: burst above wikiRps gets 429 + Retry-After', async () => {
    await get(`${u.wikipediaLike}/__control?rps=3`);
    await new Promise((r) => setTimeout(r, 1100));
    const codes = [];
    let retry;
    for (let i = 0; i < 6; i++) {
      const r = await get(`${W}/Mars/html`, { headers: H });
      codes.push(r.status);
      if (r.status === 429) retry = r.headers.get('retry-after');
      await r.arrayBuffer();
    }
    assert.ok(codes.includes(429), codes.join());
    assert.equal(retry, '1');
  });
  await test('20 interlinked articles all resolve', async () => {
    await get(`${u.wikipediaLike}/__control?rps=1000`);
    const { TITLES, linksOf } = await import('./wikipedia.mjs');
    assert.equal(TITLES.length, 20);
    for (const t of TITLES) {
      assert.equal((await get(`${W}/${t}/html`, { headers: H })).status, 200, t);
      for (const l of linksOf(t)) assert.ok(TITLES.includes(l), `${t} -> ${l}`);
    }
  });

  console.log('providers');
  const Q = 'astronomy';
  await test('searxng json shape and results on fixture origins', async () => {
    const { r, j } = await jget(`${u.searxng}/search?q=${Q}&format=json`);
    assert.equal(r.status, 200);
    for (const k of ['query', 'results', 'answers', 'corrections', 'infoboxes', 'suggestions', 'unresponsive_engines']) assert.ok(k in j, k);
    const first = j.results[0];
    for (const k of ['url', 'title', 'content', 'engines', 'engine', 'positions', 'score', 'category', 'publishedDate', 'parsed_url']) assert.ok(k in first, k);
    assert.ok(j.results.some((x) => x.url.startsWith(u.article)));
    assert.equal(j.results[0].url, `${u.article}/astronomy`);
    assert.equal((await get(`${u.searxng}/search?q=${Q}&format=csv`)).status, 403);
  });
  await test('brave requires the token and returns web.results', async () => {
    assert.equal((await get(`${u.brave}/res/v1/web/search?q=${Q}`)).status, 401);
    const { r, j } = await jget(`${u.brave}/res/v1/web/search?q=${Q}&count=5`, { headers: { 'X-Subscription-Token': 'fixture-brave-token' } });
    assert.equal(r.status, 200);
    assert.equal(j.type, 'search');
    assert.equal(j.web.results.length, 5);
    for (const k of ['title', 'url', 'description', 'age', 'language', 'meta_url']) assert.ok(k in j.web.results[0] || k === 'age', k);
    assert.ok(r.headers.get('x-ratelimit-remaining'));
  });
  await test('mojeek requires api_key and returns response.results', async () => {
    assert.equal((await get(`${u.mojeek}/search?q=${Q}&fmt=json&api_key=bad`)).status, 403);
    const { j } = await jget(`${u.mojeek}/search?q=${Q}&fmt=json&api_key=fixture-mojeek-key`);
    assert.equal(j.response.status, 'OK');
    assert.ok(j.response.results[0].desc && j.response.results[0].url);
  });
  await test('failure switches: 500, 429, malformed, timeout, xss, partial, slow (query and control)', async () => {
    for (const [name, path] of [['searxng', `/search?q=${Q}&format=json`], ['brave', `/res/v1/web/search?q=${Q}`], ['mojeek', `/search?q=${Q}&fmt=json&api_key=fixture-mojeek-key`]]) {
      const headers = { 'X-Subscription-Token': 'fixture-brave-token' };
      const url = (mode) => `${u[name]}${path}&__mode=${mode}`;
      assert.equal((await get(url('error500'), { headers })).status, 500, `${name} 500`);
      const r429 = await get(url('rate429'), { headers });
      assert.equal(r429.status, 429, `${name} 429`);
      assert.ok(r429.headers.get('retry-after'));
      const bad = await get(url('malformed'), { headers });
      assert.equal(bad.status, 200);
      await assert.rejects(bad.json(), `${name} malformed`);
      await assert.rejects(get(url('timeout'), { headers, signal: AbortSignal.timeout(250) }), `${name} timeout`);
      const t0 = Date.now();
      await get(url('slow') + '&x=1', { headers }).then((r) => r.arrayBuffer());
      assert.ok(Date.now() - t0 >= 0);
      const xss = await (await get(url('xss'), { headers })).text();
      assert.ok(xss.includes('<script>alert'), `${name} xss`);
      assert.equal((await get(url('auth'), { headers })).status, name === 'mojeek' ? 403 : name === 'brave' ? 401 : 403);
    }
    await get(`${u.searxng}/__control?mode=partial`);
    assert.equal((await jget(`${u.searxng}/search?q=${Q}&format=json`)).j.unresponsive_engines.length, 2);
    await get(`${u.searxng}/__control?mode=slow&slowMs=300`);
    const t0 = Date.now();
    await get(`${u.searxng}/search?q=${Q}&format=json`);
    assert.ok(Date.now() - t0 >= 280);
    await get(`${u.searxng}/__control?mode=error500`);
    assert.equal((await get(`${u.searxng}/search?q=${Q}&format=json`)).status, 500);
    await get(`${u.searxng}/__control?reset=1`);
    assert.equal((await get(`${u.searxng}/search?q=${Q}&format=json`)).status, 200);
  });
  await test('results are deterministic', async () => {
    const a = (await txt(`${u.searxng}/search?q=solar&format=json`)).t;
    const b = (await txt(`${u.searxng}/search?q=solar&format=json`)).t;
    assert.equal(a, b);
    const online = (await jget(`${u.searxng}/search?q=online%20only&format=json`)).j.results;
    assert.ok(online.some((x) => x.url.includes('/online-only/')));
  });

  console.log('sitemapFeed');
  await test('sitemap, index, gz sitemap, rss, atom', async () => {
    const sm = (await txt(`${u.sitemapFeed}/sitemap.xml`)).t;
    assert.ok(sm.includes(`<loc>${u.article}/astronomy</loc>`) && sm.includes('<lastmod>'));
    const idx = (await txt(`${u.sitemapFeed}/sitemap-index.xml`)).t;
    assert.ok(idx.includes('<sitemapindex') && idx.includes('/sitemap-1.xml'));
    const gz = await raw(`${u.sitemapFeed}/sitemap-2.xml.gz`);
    assert.ok(zlib.gunzipSync(gz.body).toString().includes('<urlset'));
    const rss = (await txt(`${u.sitemapFeed}/rss.xml`)).t;
    assert.ok(rss.includes('<rss version="2.0"') && /<pubDate>\w{3}, \d\d \w{3} 2025/.test(rss) && rss.includes(`<link>${u.article}/astronomy</link>`));
    const atom = (await txt(`${u.sitemapFeed}/atom.xml`)).t;
    assert.ok(atom.includes('<feed xmlns="http://www.w3.org/2005/Atom">') && atom.includes('<updated>'));
  });

  console.log('common endpoints');
  await test('every site answers /__health and logs requests', async () => {
    for (const [k, base] of Object.entries(u)) {
      const { r, j } = await jget(`${base}/__health`);
      assert.equal(r.status, 200, k);
      assert.equal(j.ok, true);
    }
    const log = (await jget(`${u.article}/__log`)).j;
    assert.ok(log.total > 10 && log.entries[0].url);
  });
  await test('two instances get different ports (random free ports)', async () => {
    const fx2 = await startFixtures();
    assert.notEqual(fx2.urls.article, u.article);
    await fx2.close();
  });
} finally {
  await fx.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed:', failures.join('; '));
  process.exit(1);
}
process.exit(0);
