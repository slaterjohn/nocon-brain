// Site 7: fake Wikimedia (core REST + Action API) with 20 interlinked astronomy articles.
// Mirrors the routes used by the plan (Z-07, Z-08): /w/rest.php/v1/page/{title}/with_html and /html,
// Action API prop=links and prop=imageinfo extmetadata, UA enforcement, rate limiting and maxlag.
import { startSite, esc, json, text, send, sendCond, redirect, makePng, hash32 } from './lib.mjs';
import { SENTENCES } from './articles-data.mjs';

export const TITLES = ['Astronomy', 'Black_hole', 'Solar_System', 'Planet', 'Sun', 'Earth', 'Moon', 'Mars', 'Jupiter', 'Saturn',
  'Star', 'Galaxy', 'Milky_Way', 'Big_Bang', 'Universe', 'Comet', 'Asteroid', 'Exoplanet', 'Telescope', 'Supernova'];
const HAND = {
  Astronomy: ['Black_hole', 'Solar_System', 'Planet', 'Star', 'Galaxy', 'Telescope'],
  Black_hole: ['Astronomy', 'Star', 'Supernova', 'Galaxy', 'Milky_Way'],
  Solar_System: ['Sun', 'Planet', 'Earth', 'Mars', 'Jupiter', 'Comet', 'Asteroid', 'Astronomy'],
};
export const REDIRECTS = { Blackhole: 'Black_hole', Black_Hole: 'Black_hole', Solar_system: 'Solar_System', Sol: 'Sun' };
export const linksOf = (title) => {
  if (HAND[title]) return HAND[title];
  const i = TITLES.indexOf(title);
  return [...new Set(['Astronomy', ...[1, 2, 5].map((o) => TITLES[(i + o) % TITLES.length])])].filter((t) => t !== title);
};
const human = (t) => t.replace(/_/g, ' ');
const BASE_TS = Date.UTC(2026, 9, 1, 12, 0, 0);

const IMAGES = (title) => {
  const nonFree = title === 'Black_hole';
  const pd = title === 'Sun';
  return {
    file: `${title}_illustration.png`,
    LicenseShortName: nonFree ? 'Fair use' : pd ? 'Public domain' : 'CC BY-SA 4.0',
    LicenseUrl: nonFree ? '' : pd ? '' : 'https://creativecommons.org/licenses/by-sa/4.0',
    UsageTerms: nonFree ? 'Non-free media' : pd ? 'Public domain' : 'Creative Commons Attribution-Share Alike 4.0',
    Copyrighted: pd ? 'False' : 'True',
    NonFree: nonFree ? 'true' : undefined,
    Artist: `<a href="//commons.wikimedia.org/wiki/User:Fixture_${title}" title="User:Fixture ${human(title)}">Fixture ${human(title)} Photographer</a>`,
    Credit: '<span class="int-own-work">Own work</span>',
    ImageDescription: `An illustration of ${human(title)} generated for tests.`,
    DateTimeOriginal: '2024-05-04',
    AttributionRequired: pd ? 'false' : 'true',
  };
};

export async function startWikipedia({ rps = 5 } = {}) {
  const state = { rps, lag: 0, bump: {}, window: [], rateLimited: 0 };

  const site = await startSite('wikipediaLike', (req, res, url) => {
    const p = url.pathname;
    const sp = url.searchParams;
    const host = req.headers.host;

    if (p === '/__control') {
      if (sp.has('rps')) state.rps = Number(sp.get('rps'));
      if (sp.has('lag')) state.lag = Number(sp.get('lag'));
      if (sp.has('bump')) state.bump[sp.get('bump')] = (state.bump[sp.get('bump')] || 0) + 1;
      if (sp.get('reset')) Object.assign(state, { rps, lag: 0, bump: {}, window: [], rateLimited: 0 });
      return json(res, { rps: state.rps, lag: state.lag, bump: state.bump, rateLimited: state.rateLimited });
    }
    const rev = (t) => 1000000 + TITLES.indexOf(t) * 17 + (state.bump[t] || 0) * 1000;
    const ts = (t) => new Date(BASE_TS + TITLES.indexOf(t) * 3600000 + (state.bump[t] || 0) * 86400000).toISOString().replace('.000Z', 'Z');

    // Static images are open (no UA or rate rules), like upload.wikimedia.org in spirit.
    let m = p.match(/^\/images\/(.+)\.png$/);
    if (m) return sendCond(req, res, 200, makePng(32, 20, [10 + (hash32(m[1]) % 200), 100, 160]), { 'Content-Type': 'image/png' });

    // User-Agent policy: must identify the client with contact information.
    const ua = req.headers['user-agent'] || '';
    if (!/(https?:\/\/\S+|[^\s@()<>]+@[^\s@()<>]+\.[^\s@()<>]+)/.test(ua)) {
      return json(res, { httpCode: 403, httpReason: 'Forbidden', error: 'Please set a user-agent and respect our robot policy. It must include contact information (URL or email).' }, 403);
    }
    // Rate limit: more than state.rps requests in any sliding 1 s window -> 429.
    const now = Date.now();
    state.window = state.window.filter((t) => now - t < 1000);
    if (state.window.length >= state.rps) {
      state.rateLimited++;
      return json(res, { httpCode: 429, httpReason: 'Too Many Requests', error: 'Too many requests' }, 429, { 'Retry-After': '1' });
    }
    state.window.push(now);

    // ---- core REST
    m = p.match(/^\/w\/rest\.php\/v1\/page\/([^/]+)(?:\/(with_html|html|bare))?$/);
    if (m) {
      const raw = decodeURIComponent(m[1]).replace(/ /g, '_');
      const norm = raw.charAt(0).toUpperCase() + raw.slice(1);
      const suffix = m[2];
      if (REDIRECTS[norm]) {
        return redirect(res, `/w/rest.php/v1/page/${REDIRECTS[norm]}${suffix ? '/' + suffix : ''}`, 307);
      }
      if (!TITLES.includes(norm)) {
        return json(res, { httpCode: 404, httpReason: 'Not Found', messageTranslations: { en: 'The page does not exist' }, errorKey: 'rest-nonexistent-title' }, 404);
      }
      const meta = {
        id: 5000 + TITLES.indexOf(norm),
        key: norm,
        title: human(norm),
        latest: { id: rev(norm), timestamp: ts(norm) },
        content_model: 'wikitext',
        license: { url: '//creativecommons.org/licenses/by-sa/4.0/deed.en', title: 'Creative Commons Attribution-Share Alike 4.0' },
      };
      if (!suffix) return json(res, { ...meta, source: `'''${human(norm)}''' wikitext source.` });
      const body = parsoidHtml(norm, host, rev(norm), state.bump[norm] || 0);
      if (suffix === 'html') {
        return sendCond(req, res, 200, body, {
          'Content-Type': 'text/html; charset=utf-8;profile="https://www.mediawiki.org/wiki/Specs/HTML/2.8.0"',
          'Content-Language': 'en',
          'Cache-Control': 'max-age=5',
          'X-Revision-Id': String(rev(norm)),
          'Last-Modified': new Date(ts(norm)).toUTCString(),
        });
      }
      return sendCond(req, res, 200, JSON.stringify({ ...meta, html: body }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=5' });
    }

    // ---- Action API
    if (p === '/w/api.php') {
      if (sp.has('maxlag') && state.lag > Number(sp.get('maxlag'))) {
        return json(res, { error: { code: 'maxlag', info: `Waiting for a database server: ${state.lag} seconds lagged.`, lag: state.lag, type: 'db' }, servedby: 'fixture' }, 200, { 'Retry-After': '5', 'X-Database-Lag': String(state.lag) });
      }
      if (sp.get('action') !== 'query') return json(res, { error: { code: 'unknown_action', info: `Unrecognized value for parameter "action": ${sp.get('action')}.` } }, 200);
      const v2 = sp.get('formatversion') === '2';
      const props = (sp.get('prop') || '').split('|');
      const pages = [];
      for (const t of (sp.get('titles') || '').split('|').filter(Boolean)) {
        const key = t.replace(/ /g, '_');
        if (key.startsWith('File:')) {
          const title = TITLES.find((x) => `File:${IMAGES(x).file}` === key);
          if (!title) { pages.push({ ns: 6, title: t, missing: '', known: '' }); continue; }
          const im = IMAGES(title);
          const ext = {};
          for (const [k, val] of Object.entries(im)) if (!['file'].includes(k) && val !== undefined) ext[k] = { value: val, source: 'commons-desc-page', hidden: '' };
          pages.push({ pageid: 9000 + TITLES.indexOf(title), ns: 6, title: t.replace(/_/g, ' '),
            ...(props.includes('imageinfo') ? { imagerepository: 'local', imageinfo: [{ url: `//${host}/images/${title}_illustration.png`, descriptionurl: `//${host}/wiki/File:${im.file}`, descriptionshorturl: `//${host}/w/index.php?curid=${9000 + TITLES.indexOf(title)}`, ...(sp.get('iiprop') || '').split('|').includes('extmetadata') ? { extmetadata: ext } : {} }] } : {}) });
          continue;
        }
        const norm = REDIRECTS[key] || key;
        if (!TITLES.includes(norm)) { pages.push({ ns: 0, title: human(key), missing: '' }); continue; }
        const pg = { pageid: 5000 + TITLES.indexOf(norm), ns: 0, title: human(norm) };
        if (props.includes('links')) {
          const nsFilter = sp.has('plnamespace') ? String(sp.get('plnamespace')).split('|') : null;
          let links = [...linksOf(norm).map((x) => ({ ns: 0, title: human(x) })), { ns: 14, title: 'Category:Astronomy' }, { ns: 10, title: 'Template:Reflist' }, { ns: 6, title: `File:${IMAGES(norm).file.replace(/_/g, ' ')}` }];
          if (nsFilter) links = links.filter((l) => nsFilter.includes(String(l.ns)));
          pg.links = links;
        }
        if (props.includes('info')) Object.assign(pg, { contentmodel: 'wikitext', pagelanguage: 'en', lastrevid: rev(norm), touched: ts(norm), length: 2000 });
        pages.push(pg);
      }
      const query = v2 ? { pages } : { pages: Object.fromEntries(pages.map((pg, i) => [pg.pageid ?? `-${i + 1}`, pg])) };
      return json(res, { batchcomplete: v2 ? true : '', query });
    }

    // ---- human-facing pages (minimal) so links resolve in a browser
    m = p.match(/^\/wiki\/(.+)$/);
    if (m) return send(res, 200, parsoidHtml(m[1], host, rev(m[1]) || 0, 0), { 'Content-Type': 'text/html; charset=utf-8' });
    return json(res, { httpCode: 404, httpReason: 'Not Found' }, 404);
  });
  return site;
}

function parsoidHtml(title, host, revId, bump) {
  const t = human(title);
  const i = Math.max(0, TITLES.indexOf(title));
  const pool = SENTENCES.astro;
  const link = (x) => `<a rel="mw:WikiLink" href="./${x}" title="${esc(human(x))}">${esc(human(x).toLowerCase() === t.toLowerCase() ? human(x) : human(x))}</a>`;
  const kids = linksOf(title);
  const img = IMAGES(title);
  const paras = [0, 1, 2, 3].map((k) => esc(pool[(i + k * 5) % pool.length]));
  return `<!DOCTYPE html>
<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="//${host}/wiki/Special:Redirect/revision/${revId}"><head prefix="mwr: //${host}/wiki/Special:Redirect/"><meta charset="utf-8"/><meta property="mw:pageId" content="${5000 + i}"/><meta property="mw:pageNamespace" content="0"/><meta property="mw:revisionSHA1" content="${hash32(title + bump).toString(16).padStart(8, '0')}"/><meta property="dc:modified" content="2026-10-01T12:00:00.000Z"/><meta property="mw:htmlVersion" content="2.8.0"/><link rel="dc:isVersionOf" href="//${host}/wiki/${title}"/><base href="//${host}/wiki/"/><title>${esc(t)}</title><link rel="stylesheet" href="//${host}/w/load.php?modules=mediawiki.skinning.content.parsoid&amp;only=styles"/></head><body id="mwAA" lang="en" class="mw-body-content parsoid-body mw-parser-output sitedir-ltr ltr mediawiki" dir="ltr"><section data-mw-section-id="0" id="mwAQ"><div role="note" class="hatnote navigation-not-searchable">For other uses, see <a rel="mw:WikiLink" href="./${title}_(disambiguation)" title="${esc(t)} (disambiguation)" class="new">${esc(t)} (disambiguation)</a>.</div>
<p id="mwAg"><b>${esc(t)}</b> ${bump ? '(updated) ' : ''}is a subject in <a rel="mw:WikiLink" href="./Astronomy" title="Astronomy">astronomy</a>. ${kids.map(link).join(', ')}.</p>
<figure class="mw-default-size" typeof="mw:File/Thumb"><a href="./File:${img.file}" class="mw-file-description"><img resource="./File:${img.file}" src="//${host}/images/${img.file}" alt="${esc(t)}" width="32" height="20"/></a><figcaption>${esc(t)}, illustrated.</figcaption></figure></section>
<section data-mw-section-id="1" id="mwAw"><h2 id="History">History</h2>${paras.map((x) => `<p>${x}</p>`).join('')}<p>See <a rel="mw:WikiLink" href="./${kids[0]}#History" title="${esc(human(kids[0]))}">${esc(human(kids[0]))}</a> and <a rel="mw:WikiLink" href="./Category:Astronomy" title="Category:Astronomy">the category</a>, <a rel="mw:WikiLink" href="./Template:Reflist" title="Template:Reflist">a template</a>, and <a rel="mw:WikiLink" href="./Nonexistent_page_${i}?action=edit&amp;redlink=1" title="Nonexistent page ${i}" class="new">a missing page</a>.</p></section>
<section data-mw-section-id="2" id="mwBA"><h2 id="External_links">External links</h2><ul><li><a rel="mw:ExtLink" class="external text" href="https://example.org/${title}">Official site</a></li></ul></section>
<link rel="mw:PageProp/Category" href="./Category:Astronomy"/></body></html>`;
}
