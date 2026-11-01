// Site 3: crawl traps. Every trap generates new, unbounded links on each page.
import { startSite, esc, html, redirect, notFound, hash32 } from './lib.mjs';

const page = (title, body, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body><main><article><h1>${esc(title)}</h1>${body}</article></main><nav><a href="/">Trap home</a></nav></body></html>`;

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;

export async function startTrap() {
  const site = await startSite('trap', (req, res, url) => {
    const p = url.pathname;
    const sp = url.searchParams;

    if (p === '/') {
      return html(res, page('Crawl trap home', `<p>Each link below leads into a different trap.</p><ul>
<li><a href="/cal/2026/11/01">Infinite calendar</a></li>
<li><a href="/a">Repeating segments /a/a/a</a> and <a href="/a/b/a/b">/a/b/a/b</a></li>
<li><a href="/sess/page?sid=s1">Session IDs in the query</a> and <a href="/sess/page;jsessionid=J1">in the path</a></li>
<li><a href="/list?page=1">Infinite pagination</a></li>
<li><a href="/facets?sort=price&amp;filter=a">Facet combinations</a></li>
<li><a href="/redirect/loop-a">Redirect loop</a> and <a href="/redirect/self">self redirect</a></li>
<li><a href="/track/article?utm_source=news&amp;utm_medium=email&amp;utm_campaign=c1&amp;fbclid=f1&amp;gclid=g1">Tracking parameters</a></li>
<li><a href="/real/1">A real, finite section (3 pages)</a></li></ul>`));
    }

    // Finite control section so tests can check legitimate pages are still crawled.
    let m = p.match(/^\/real\/([123])$/);
    if (m) {
      const n = +m[1];
      return html(res, page(`Real page ${n}`, `<p>Genuine content ${n}.</p>${n < 3 ? `<p><a href="/real/${n + 1}">Next real page</a></p>` : ''}`));
    }

    // 1. Infinite calendar: any date is valid, next/prev/month links forever.
    m = p.match(/^\/cal\/(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (Number.isNaN(d.getTime())) return notFound(res);
      const nx = new Date(d.getTime() + 86400000);
      const pv = new Date(d.getTime() - 86400000);
      return html(res, page(`Calendar ${fmt(d)}`, `<p>No events on ${fmt(d)}.</p>
<p><a href="/cal/${fmt(pv)}" rel="prev">Previous day</a> | <a href="/cal/${fmt(nx)}" rel="next">Next day</a></p>
<p><a href="/cal/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/01">Start of month</a> <a href="/cal/${d.getUTCFullYear() + 1}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}">Next year</a></p>`));
    }

    // 2. Repeating path segments: /a/a/a/..., /a/b/a/b/...
    if (/^(\/[ab])+\/?$/.test(p)) {
      const base = p.replace(/\/$/, '');
      return html(res, page(`Segment ${base}`, `<p>You are ${base.split('/').length - 1} levels deep.</p><a href="${base}/a">deeper a</a> <a href="${base}/b">deeper b</a> <a href="./a">relative a</a>`));
    }

    // 3. Session ids: same content, a new id in every link (query and path-parameter flavours).
    if (p === '/sess/page' || p.startsWith('/sess/page;')) {
      const sid = sp.get('sid') || p.split('jsessionid=')[1] || 'none';
      const n = (parseInt(sid.replace(/\D/g, ''), 10) || 0) + 1;
      return html(res, page('Session page', `<p>The same content, whatever the session id.</p>
<a href="/sess/page?sid=s${n}&amp;PHPSESSID=p${n}">Link with query session</a>
<a href="/sess/page;jsessionid=J${n}">Link with path session</a>`), 200, { 'Set-Cookie': `sid=s${n}; Path=/` });
    }

    // 4a. Infinite pagination with no last page.
    if (p === '/list') {
      const n = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
      return html(res, page(`List page ${n}`, `<ul>${[0, 1, 2].map((i) => `<li>Item ${n * 3 + i}</li>`).join('')}</ul><a href="/list?page=${n + 1}" rel="next">Next page</a>${n > 1 ? ` <a href="/list?page=${n - 1}" rel="prev">Previous</a>` : ''}`));
    }
    // 4b. Facet combinations: identical content, many orderings and values, plus one extra param per hop.
    if (p === '/facets') {
      const links = [];
      for (const s of ['price', 'name', 'date', 'rating']) for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) for (const v of ['grid', 'list']) {
        links.push(`/facets?sort=${s}&amp;filter=${f}&amp;view=${v}`, `/facets?view=${v}&amp;filter=${f}&amp;sort=${s}`);
      }
      links.push(`/facets?${[...sp].map(([k, v]) => `${k}=${v}`).join('&amp;')}&amp;x=${[...sp.keys()].length + 1}`);
      return html(res, page('Facets', `<p>The same product list for every combination.</p><ul><li>Widget</li><li>Gadget</li></ul>${links.map((l) => `<a href="${l}">f</a>`).join(' ')}`));
    }

    // 5. Redirect loops.
    if (p === '/redirect/loop-a') return redirect(res, '/redirect/loop-b', 302);
    if (p === '/redirect/loop-b') return redirect(res, '/redirect/loop-a', 302);
    if (p === '/redirect/self') return redirect(res, '/redirect/self', 301);

    // 6. A page linking to itself with endlessly changing tracking params.
    if (p === '/track/article') {
      const n = (hash32(url.search) % 100000) + 1;
      return html(res, page('Tracked article', `<p>Real content that never changes.</p>
<a href="/track/article?utm_source=n${n}&amp;utm_medium=email&amp;utm_campaign=c${n}&amp;fbclid=f${n}&amp;gclid=g${n}">Share this article</a>
<a href="/track/article?utm_term=t${n}&amp;utm_content=x${n}&amp;ref=r${n}">Another tracked link</a>`,
      `<link rel="canonical" href="${site.origin}/track/article">`));
    }
    return notFound(res);
  });
  return site;
}
