// Site 2: a ~200 page link graph with a known structure, published at /__graph.json.
//
// Structure (node ids are BFS order, URL /n/{id}):
//   depth 0: node 0 (root, also served at /)
//   depth 1: nodes 1..6      (children of 0)
//   depth 2: nodes 7..36     (5 children for each of 1..6)
//   depth 3: nodes 37..186   (5 children for each of 7..36)
//   depth 4: nodes 187..199  (1 child for each of 37..49)
// Link regions on every node page:
//   main     parent->children (paragraph links), a heading link to the first child, a sibling link in "related"
//   nav      links to /, and to nodes 1..6 (this never shortens depth because the root already links to 1..6)
//   footer   links to /legal/terms, /legal/privacy, a broken /legal/old, and an external link
// Every 17th node also has a broken main-content link (/missing/{id}); every 10th node links to another fixture origin.
import { startSite, esc, html, json, notFound } from './lib.mjs';

const N = 200;
export function buildGraph() {
  const parent = new Array(N).fill(null);
  const children = Array.from({ length: N }, () => []);
  let next = 1;
  const ranges = [[0, 0, 6], [1, 6, 5], [7, 36, 5], [37, 49, 1]];
  for (const [from, to, per] of ranges) {
    for (let id = from; id <= to; id++) {
      for (let k = 0; k < per; k++) {
        parent[next] = id;
        children[id].push(next);
        next++;
      }
    }
  }
  if (next !== N) throw new Error(`graph builder produced ${next} nodes`);
  const depth = new Array(N).fill(0);
  for (let i = 1; i < N; i++) depth[i] = depth[parent[i]] + 1;
  return { parent, children, depth };
}

const EXTERNAL_KEYS = ['article', 'trap', 'wikipediaLike', 'robots'];
const externalFor = (id) => (id % 10 === 0 ? EXTERNAL_KEYS[(id / 10) % EXTERNAL_KEYS.length] : null);
const externalPath = { article: '/astronomy', trap: '/', wikipediaLike: '/w/rest.php/v1/page/Astronomy/html', robots: '/public/page-1' };

export async function startLinkGraph(ctx) {
  const g = buildGraph();
  const title = (id) => `Node ${id} (depth ${g.depth[id]})`;

  function linksFor(id) {
    const links = []; // {to, region}
    const kids = g.children[id];
    kids.forEach((k, i) => links.push({ to: `/n/${k}`, region: i === 0 ? 'heading' : 'main' }));
    if (id % 17 === 0 && id !== 0) links.push({ to: `/missing/${id}`, region: 'main', broken: true });
    const ext = externalFor(id);
    if (ext) links.push({ to: null, region: 'main', external: ext });
    const sibs = g.parent[id] === null ? [] : g.children[g.parent[id]];
    const nextSib = sibs[(sibs.indexOf(id) + 1) % Math.max(sibs.length, 1)];
    if (nextSib !== undefined && nextSib !== id) links.push({ to: `/n/${nextSib}`, region: 'related' });
    links.push({ to: '/', region: 'nav' });
    for (let k = 1; k <= 6; k++) links.push({ to: `/n/${k}`, region: 'nav' });
    links.push({ to: '/legal/terms', region: 'footer' }, { to: '/legal/privacy', region: 'footer' }, { to: '/legal/old', region: 'footer', broken: true });
    links.push({ to: null, region: 'footer', external: 'article' });
    return links;
  }

  const resolve = (l) => (l.external ? `${ctx.urls[l.external]}${externalPath[l.external] ?? '/'}` : l.to);
  const abs = (origin, u) => (u.startsWith('/') ? origin + u : u);

  const site = await startSite('linkGraph', (req, res, url) => {
    const origin = site.origin;
    const p = url.pathname;
    if (p === '/__graph.json') {
      const nodes = [];
      const edges = [];
      for (let id = 0; id < N; id++) {
        nodes.push({ id, url: `${origin}/n/${id}`, depth: g.depth[id], parent: g.parent[id], children: g.children[id], kind: 'content' });
        for (const l of linksFor(id)) {
          const to = abs(origin, resolve(l));
          edges.push({ from: `${origin}/n/${id}`, to, region: l.region, broken: !!l.broken, external: !!l.external });
        }
      }
      nodes.push({ id: 'terms', url: `${origin}/legal/terms`, depth: 1, parent: 0, kind: 'footer-only' }, { id: 'privacy', url: `${origin}/legal/privacy`, depth: 1, parent: 0, kind: 'footer-only' });
      const byDepth = {};
      g.depth.forEach((d) => (byDepth[d] = (byDepth[d] || 0) + 1));
      return json(res, {
        root: `${origin}/n/0`,
        homeAlias: `${origin}/`,
        nodeCount: N,
        utilityPages: 2,
        maxDepth: Math.max(...g.depth),
        countsByDepth: byDepth,
        brokenTargets: [...new Set(edges.filter((e) => e.broken).map((e) => e.to))],
        regions: ['heading', 'main', 'related', 'nav', 'footer'],
        note: 'depth = shortest path from root over all links (nav/footer links never shorten it). Node pages link to children in main/heading regions.',
        nodes,
        edges,
      });
    }
    if (p === '/legal/terms' || p === '/legal/privacy') {
      return html(res, `<!doctype html><title>${p.slice(7)}</title><main><h1>${p.slice(7)}</h1><p>Legal boilerplate.</p><a href="/">Home</a></main>`);
    }
    let id = null;
    if (p === '/') id = 0;
    const m = p.match(/^\/n\/(\d+)$/);
    if (m && +m[1] < N) id = +m[1];
    if (id === null) return notFound(res);

    const links = linksFor(id).map((l) => ({ ...l, href: resolve(l) }));
    const by = (r) => links.filter((l) => l.region === r);
    const a = (l, label) => `<a href="${esc(l.href)}">${esc(label ?? l.href)}</a>`;
    const heading = by('heading')[0];
    const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title(id)}</title></head><body>
<nav>${by('nav').map((l) => a(l)).join(' ')}</nav>
<main><article>
<h1>${title(id)}</h1>
<p>This is node ${id} of the link-graph fixture. Its parent is ${g.parent[id] ?? 'none'}.</p>
${heading ? `<h2>${a(heading, `Start here: node ${heading.href.split('/').pop()}`)}</h2>` : ''}
${by('main').map((l) => `<p>Continue reading ${a(l)}${l.external ? ' (another site)' : ''}${l.broken ? ' (a link that is dead)' : ''}.</p>`).join('\n')}
</article></main>
<aside><h2>Related</h2>${by('related').map((l) => a(l)).join(' ')}</aside>
<footer>${by('footer').map((l) => a(l)).join(' | ')}</footer>
</body></html>`;
    return html(res, body);
  });
  return site;
}
