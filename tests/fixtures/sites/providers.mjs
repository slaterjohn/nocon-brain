// Site 8: fake search providers (SearXNG, Brave, Mojeek) with failure switches.
//
// Failure modes (per provider), set persistently with  GET /__control?mode=<mode>[&slowMs=N][&retryAfter=S]
// or for a single request with  ?__mode=<mode>  on the search URL (or header X-Fixture-Mode):
//   ok | slow | error500 | timeout | rate429 | malformed | auth | empty | xss | partial (searxng only)
import { startSite, json, text, send, sleep, esc } from './lib.mjs';
import { ARTICLES, ONLINE_ONLY } from './articles-data.mjs';

export const BRAVE_TOKEN = 'fixture-brave-token';
export const MOJEEK_KEY = 'fixture-mojeek-key';

/** Deterministic catalogue pointing at article, linkGraph and online-only URLs. */
export function catalogue(ctx) {
  const art = ctx.urls.article;
  const lg = ctx.urls.linkGraph;
  const items = [];
  for (const a of ARTICLES.filter((x) => !x.copyOf && !x.lang)) {
    items.push({ url: `${art}/${a.slug}`, title: a.title, snippet: `${a.lead || a.title + ' explained.'}`.slice(0, 160), date: a.published, kind: 'article' });
  }
  for (const id of [0, 1, 2, 7, 37, 100]) {
    items.push({ url: `${lg}/n/${id}`, title: `Node ${id} of the link graph`, snippet: `Link graph fixture node ${id}. Astronomy planets graph.`, date: '2025-06-01T00:00:00Z', kind: 'linkgraph' });
  }
  for (const o of ONLINE_ONLY) {
    items.push({ url: `${art}/online-only/${o.id}`, title: o.title, snippet: o.snippet, date: '2026-10-30T08:00:00Z', kind: 'online-only' });
  }
  return items;
}

/** Deterministic ranking: number of query-term hits in title (x3) and snippet, ties by catalogue order. */
export function search(ctx, q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const items = catalogue(ctx).map((it, i) => {
    const hay = (s) => terms.reduce((n, t) => n + (s.toLowerCase().includes(t) ? 1 : 0), 0);
    return { it, i, score: hay(it.title) * 3 + hay(it.snippet) + hay(it.url) };
  });
  const hits = items.filter((x) => x.score > 0 || !terms.length);
  const pool = hits.length ? hits : items.slice(0, 5); // unmatched queries still return something
  return pool.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.it);
}

const XSS = [
  { title: '<script>alert("xss-title")</script>Totally normal result', snippet: '<img src=x onerror=alert("xss-snippet")> click <b onmouseover=alert(1)>here</b>', url: 'javascript:alert("xss-url")' },
  { title: '<svg onload=alert(1)>SVG title', snippet: '&lt;already escaped&gt; <iframe src="//evil.invalid"></iframe>', url: 'data:text/html,<script>alert(1)</script>' },
  { title: 'Private address result', snippet: 'Points at metadata service', url: 'http://169.254.169.254/latest/meta-data/' },
];

function makeProvider(name, ctx, { respond, authOk, parseRequest }) {
  const state = { mode: 'ok', slowMs: 3000, retryAfter: 2, requests: 0 };
  return startSite(name, async (req, res, url) => {
    const p = url.pathname;
    if (p === '/__control') {
      if (url.searchParams.has('mode')) state.mode = url.searchParams.get('mode');
      if (url.searchParams.has('slowMs')) state.slowMs = Number(url.searchParams.get('slowMs'));
      if (url.searchParams.has('retryAfter')) state.retryAfter = Number(url.searchParams.get('retryAfter'));
      if (url.searchParams.get('reset')) Object.assign(state, { mode: 'ok', slowMs: 3000, retryAfter: 2, requests: 0 });
      return json(res, state);
    }
    const parsed = parseRequest(req, url);
    if (!parsed) return text(res, 'not found', 404);
    state.requests++;
    const mode = url.searchParams.get('__mode') || req.headers['x-fixture-mode'] || state.mode;
    if (mode === 'timeout') return void (await new Promise((r) => res.once('close', r)));
    if (mode === 'error500') return json(res, { error: 'internal fixture error' }, 500);
    if (mode === 'rate429') return json(res, { error: 'rate limited' }, 429, { 'Retry-After': String(state.retryAfter), 'X-RateLimit-Remaining': '0' });
    if (mode === 'slow') await sleep(state.slowMs);
    if (mode !== 'auth' && authOk && !authOk(req, url)) return authFailure(name, res);
    if (mode === 'auth') return authFailure(name, res);
    if (mode === 'malformed') return send(res, 200, '{"results": [ {"title": "truncated", "url": ', { 'Content-Type': 'application/json' });
    return respond(req, res, url, parsed, mode, state);
  });
}

function authFailure(name, res) {
  if (name === 'brave') return json(res, { type: 'ErrorResponse', error: { id: 'fixture-401', status: 401, code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'The provided subscription token is invalid.', meta: {} } }, 401);
  if (name === 'mojeek') return json(res, { response: { status: 'Invalid API key' } }, 403);
  return text(res, 'Forbidden', 403);
}

const pageSlice = (arr, page, size) => arr.slice((page - 1) * size, page * size);
const hostParts = (u) => { try { const x = new URL(u); return { scheme: x.protocol.replace(':', ''), netloc: x.host, hostname: x.hostname, path: x.pathname }; } catch { return { scheme: '', netloc: '', hostname: '', path: '' }; } };

export function startSearxng(ctx) {
  return makeProvider('searxng', ctx, {
    parseRequest: (req, url) => (url.pathname === '/search' ? { q: url.searchParams.get('q') || '' } : null),
    respond(req, res, url, { q }, mode) {
      const format = url.searchParams.get('format');
      if (format !== 'json') {
        // Real SearXNG answers 403 for formats that are not enabled in settings.yml.
        if (format) return text(res, 'Forbidden: format not enabled', 403);
        return send(res, 200, '<!doctype html><title>SearXNG fixture</title><p>HTML results page</p>', { 'Content-Type': 'text/html' });
      }
      const pageno = Math.max(1, Number(url.searchParams.get('pageno') || 1));
      let rows = mode === 'empty' ? [] : search(ctx, q);
      if (mode === 'xss') rows = [...XSS.map((x) => ({ ...x, kind: 'xss', date: null })), ...rows];
      rows = pageSlice(rows, pageno, 10);
      const results = rows.map((r, i) => {
        const h = hostParts(r.url);
        return {
          url: r.url,
          title: r.title,
          content: r.snippet,
          engine: i % 2 ? 'duckduckgo' : 'brave',
          engines: i % 2 ? ['duckduckgo', 'google'] : ['brave', 'duckduckgo'],
          positions: [i + 1, i + 2],
          score: Number((3 / (i + 1)).toFixed(4)),
          category: 'general',
          publishedDate: r.date || null,
          thumbnail: null,
          img_src: null,
          template: 'default.html',
          parsed_url: [h.scheme, h.netloc, h.path, '', '', ''],
          priority: '',
          pretty_url: r.url,
        };
      });
      return json(res, {
        query: q,
        number_of_results: 0,
        results,
        answers: [],
        corrections: [],
        infoboxes: q.toLowerCase().includes('astronomy') && pageno === 1
          ? [{ infobox: 'Astronomy', id: 'https://en.wikipedia.org/wiki/Astronomy', content: 'Astronomy is a natural science that studies celestial objects.', urls: [{ title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Astronomy' }], engine: 'wikipedia', engines: ['wikipedia'] }]
          : [],
        suggestions: q ? [`${q} basics`, `${q} history`] : [],
        unresponsive_engines: mode === 'partial' ? [['google', 'timeout'], ['bing', 'HTTP error']] : [],
      });
    },
  });
}

export function startBrave(ctx) {
  return makeProvider('brave', ctx, {
    parseRequest: (req, url) => (url.pathname === '/res/v1/web/search' ? { q: url.searchParams.get('q') } : null),
    authOk: (req) => req.headers['x-subscription-token'] === BRAVE_TOKEN,
    respond(req, res, url, { q }, mode) {
      if (!q) return json(res, { type: 'ErrorResponse', error: { id: 'fixture-422', status: 422, code: 'VALIDATION', detail: 'q is required', meta: {} } }, 422);
      const count = Math.min(20, Math.max(1, Number(url.searchParams.get('count') || 10)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      let rows = mode === 'empty' ? [] : search(ctx, q);
      if (mode === 'xss') rows = [...XSS.map((x) => ({ ...x, kind: 'xss', date: null })), ...rows];
      rows = rows.slice(offset * count, offset * count + count);
      const results = rows.map((r) => {
        const h = hostParts(r.url);
        return {
          title: r.title,
          url: r.url,
          is_source_local: false,
          is_source_both: false,
          description: r.snippet,
          page_age: r.date ? r.date.replace(/Z$/, '') : undefined,
          profile: { name: h.hostname, url: `${h.scheme}://${h.netloc}`, long_name: h.hostname, img: `${h.scheme}://${h.netloc}/favicon.ico` },
          language: 'en',
          family_friendly: true,
          type: 'search_result',
          subtype: 'generic',
          is_live: false,
          meta_url: { scheme: h.scheme, netloc: h.netloc, hostname: h.hostname, favicon: `${h.scheme}://${h.netloc}/favicon.ico`, path: h.path },
          age: r.date ? 'fixture age' : undefined,
          extra_snippets: [`${r.snippet.slice(0, 40)}...`],
        };
      });
      return json(res, {
        type: 'search',
        query: { original: q, show_strict_warning: false, is_navigational: false, is_news_breaking: false, spellcheck_off: false, country: 'us', bad_results: false, should_fallback: false, postal_code: '', city: '', header_country: '', more_results_available: results.length === count, state: '' },
        mixed: { type: 'mixed', main: results.map((_, index) => ({ type: 'web', index, all: false })), top: [], side: [] },
        web: { type: 'search', family_friendly: true, results },
      }, 200, { 'X-RateLimit-Limit': '1, 15000', 'X-RateLimit-Policy': '1;w=1, 15000;w=2592000', 'X-RateLimit-Remaining': '0, 14999', 'X-RateLimit-Reset': '1, 2592000' });
    },
  });
}

export function startMojeek(ctx) {
  // Shape follows Mojeek's documented JSON: response.head + response.results[]. Field names are
  // best-effort from the public API page; keep README note about that in sync.
  return makeProvider('mojeek', ctx, {
    parseRequest: (req, url) => (url.pathname === '/search' ? { q: url.searchParams.get('q') || '' } : null),
    authOk: (req, url) => url.searchParams.get('api_key') === MOJEEK_KEY,
    respond(req, res, url, { q }, mode) {
      if (url.searchParams.get('fmt') !== 'json') return text(res, 'fixture supports fmt=json only', 400);
      const t = Math.min(10, Math.max(1, Number(url.searchParams.get('t') || 10)));
      const s = Math.max(1, Number(url.searchParams.get('s') || 1));
      let rows = mode === 'empty' ? [] : search(ctx, q);
      if (mode === 'xss') rows = [...XSS.map((x) => ({ ...x, kind: 'xss', date: null })), ...rows];
      const total = rows.length;
      rows = rows.slice(s - 1, s - 1 + t);
      return json(res, {
        response: {
          status: 'OK',
          head: { query: q, language: 'en', location: 'GB', results: total, return: rows.length, start: s, next: s + rows.length <= total ? s + rows.length : null, time: 0.012, safe: 0 },
          results: rows.map((r, i) => ({
            url: r.url,
            title: r.title,
            desc: r.snippet,
            size: 12000 + i,
            date: r.date ? r.date.slice(0, 10) : '',
            rank: s + i,
            dkw: [],
          })),
        },
      });
    },
  });
}
