// Site 4: robots.txt scenarios. One instance serves real rules; others vary the robots.txt status.
import { startSite, esc, html, text, xml, redirect, sleep } from './lib.mjs';

export const robotsTxt = (origin) => `# Fixture robots.txt (deterministic)
User-agent: *
Disallow: /private/
Disallow: /search
Disallow: /*.pdf$
Disallow: /tmp*/
Allow: /private/public-note
Crawl-delay: 2

User-agent: NoConBrain
Disallow: /noconbrain-blocked/
Allow: /
Crawl-delay: 1

User-agent: BadBot
Disallow: /

User-agent: SlowBot
Crawl-delay: 100

Sitemap: ${origin}/sitemap.xml
`;

/** mode: 'main' | '404' | '500' | 'redirect' | 'timeout' */
export async function startRobots(mode = 'main', { timeoutMs = 30000 } = {}) {
  const site = await startSite(`robots-${mode}`, async (req, res, url) => {
    const p = url.pathname;
    if (p === '/robots.txt') {
      if (mode === '404') return text(res, 'no robots here', 404);
      if (mode === '500') return text(res, 'robots server error', 500);
      if (mode === 'redirect') return redirect(res, '/real-robots.txt', 301);
      if (mode === 'timeout') {
        await sleep(timeoutMs);
        return text(res, 'User-agent: *\nDisallow:\n');
      }
      return text(res, robotsTxt(site.origin));
    }
    if (p === '/real-robots.txt') return text(res, robotsTxt(site.origin));
    if (p === '/sitemap.xml') {
      const urls = ['/public/page-1', '/public/page-2', '/private/secret'];
      return xml(res, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${site.origin}${u}</loc></url>`).join('')}</urlset>`);
    }
    if (p === '/' || p === '/index.html') {
      const links = ['/public/page-1', '/public/page-2', '/private/secret', '/private/public-note', '/search?q=x', '/files/doc.pdf', '/files/doc.pdf?download=1', '/tmp1/scratch/', '/noconbrain-blocked/page', '/allowed/page'];
      return html(res, `<!doctype html><title>Robots fixture (${mode})</title><h1>Robots fixture (${mode})</h1><ul>${links.map((l) => `<li><a href="${l}">${esc(l)}</a></li>`).join('')}</ul>`);
    }
    if (p.endsWith('.pdf')) return send200(res, 'application/pdf', '%PDF-1.4 fixture');
    return html(res, `<!doctype html><title>${esc(p)}</title><main><h1>Page ${esc(p)}</h1><p>Served by the robots fixture (${mode}).</p><a href="/">Home</a></main>`);
  });
  return site;
}
function send200(res, type, body) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
