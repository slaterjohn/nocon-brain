// Site 9: sitemaps and feeds that point at the article site.
import { startSite, esc, xml, text, send, gzip, notFound } from './lib.mjs';
import { ARTICLES, authorFor } from './articles-data.mjs';

const items = () => ARTICLES.filter((a) => !a.lang);

export async function startSitemapFeed(ctx) {
  const site = await startSite('sitemapFeed', (req, res, url) => {
    const art = ctx.urls.article;
    const o = site.origin;
    const list = items();
    const half = Math.ceil(list.length / 2);
    const parts = [list.slice(0, half), list.slice(half)];
    const urlset = (rows) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map((a, i) => `  <url><loc>${art}/${a.slug}</loc><lastmod>${a.modified}</lastmod><changefreq>${i % 2 ? 'weekly' : 'monthly'}</changefreq><priority>${i % 3 ? '0.5' : '0.8'}</priority></url>`).join('\n')}
</urlset>
`;
    switch (url.pathname) {
      case '/': return text(res, 'sitemap/feed fixture: /sitemap.xml /sitemap-index.xml /rss.xml /atom.xml');
      case '/robots.txt': return text(res, `User-agent: *\nAllow: /\nSitemap: ${o}/sitemap-index.xml\nSitemap: ${o}/sitemap.xml\n`);
      case '/sitemap.xml': return xml(res, urlset(list));
      case '/sitemap-index.xml':
        return xml(res, `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${o}/sitemap-1.xml</loc><lastmod>${parts[0].at(-1).modified}</lastmod></sitemap>
  <sitemap><loc>${o}/sitemap-2.xml.gz</loc><lastmod>${parts[1].at(-1).modified}</lastmod></sitemap>
</sitemapindex>
`);
      case '/sitemap-1.xml': return xml(res, urlset(parts[0]));
      case '/sitemap-2.xml': return xml(res, urlset(parts[1]));
      case '/sitemap-2.xml.gz': return send(res, 200, gzip(Buffer.from(urlset(parts[1]))), { 'Content-Type': 'application/gzip' });
      case '/rss.xml': {
        const rows = list.slice(0, 15);
        return xml(res, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Fixture Gazette</title>
  <link>${art}/</link>
  <description>Deterministic feed for tests</description>
  <language>en</language>
  <lastBuildDate>${new Date(rows.at(-1).modified).toUTCString()}</lastBuildDate>
  <atom:link href="${o}/rss.xml" rel="self" type="application/rss+xml"/>
${rows.map((a) => `  <item><title>${esc(a.title)}</title><link>${art}/${a.slug}</link><guid isPermaLink="true">${art}/${a.slug}</guid><pubDate>${new Date(a.published).toUTCString()}</pubDate><dc:creator>${authorFor(a.slug)}</dc:creator><description>${esc((a.lead || a.title).slice(0, 120))}</description></item>`).join('\n')}
</channel>
</rss>
`, 200, {}, 'application/rss+xml');
      }
      case '/atom.xml': {
        const rows = list.slice(0, 15);
        return xml(res, `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Fixture Gazette</title>
  <link href="${o}/atom.xml" rel="self"/>
  <link href="${art}/"/>
  <id>${art}/</id>
  <updated>${rows.at(-1).modified}</updated>
${rows.map((a) => `  <entry><title>${esc(a.title)}</title><link href="${art}/${a.slug}"/><id>${art}/${a.slug}</id><published>${a.published}</published><updated>${a.modified}</updated><author><name>${authorFor(a.slug)}</name></author><summary>${esc((a.lead || a.title).slice(0, 120))}</summary></entry>`).join('\n')}
</feed>
`, 200, {}, 'application/atom+xml');
      }
      default: return notFound(res);
    }
  });
  return site;
}
