// Site 5: edge cases for the fetcher: slow, huge, bombs, wrong types, conditional requests, 429/503, redirects.
import zlib from 'node:zlib';
import { startSite, esc, html, text, json, send, redirect, notFound, sleep, makePng } from './lib.mjs';

const REDIRECT_CODES = [301, 302, 307, 308];
const bombCache = new Map();
function bomb(mb, layers = 1) {
  const key = `${mb}x${layers}`;
  if (!bombCache.has(key)) {
    let buf = zlib.gzipSync(Buffer.alloc(mb * 1024 * 1024, 0), { level: 9 });
    for (let i = 1; i < layers; i++) buf = zlib.gzipSync(buf, { level: 9 });
    bombCache.set(key, buf);
  }
  return bombCache.get(key);
}
const clampInt = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d));

export async function startEdge(ctx, { slowMs = 2000 } = {}) {
  const state = {
    condVersion: 1,
    etagSalt: '',
    gone: false,
    slowMs,
    flaky: {},
    once: {},
    condHits: { total: 0, notModified: 0 },
  };
  const lastModified = (v) => new Date(Date.UTC(2025, 0, 1) + v * 86400000).toUTCString();

  const site = await startSite('edge', async (req, res, url) => {
    const p = url.pathname;
    const sp = url.searchParams;

    // ---- control
    if (p === '/__control') {
      if (sp.get('reset')) {
        Object.assign(state, { condVersion: 1, etagSalt: '', gone: false, flaky: {}, once: {}, condHits: { total: 0, notModified: 0 }, slowMs });
      }
      if (sp.has('cond_version')) state.condVersion = clampInt(sp.get('cond_version'), 1, 1, 1e6);
      if (sp.has('etag_salt')) state.etagSalt = sp.get('etag_salt');
      if (sp.has('gone')) state.gone = sp.get('gone') === '1';
      if (sp.has('slowMs')) state.slowMs = clampInt(sp.get('slowMs'), slowMs, 0, 60000);
      return json(res, state);
    }

    if (p === '/') {
      const routes = ['/slow', '/delay/500', '/slow-body?ms=100&chunks=5', '/huge', '/huge?bytes=10485760', '/huge-length', '/bomb.gz', '/bomb.gz?mb=10', '/bomb-layers?n=7',
        '/type/html-as-plain', '/type/html-as-image', '/type/png-as-html', '/type/no-type', '/chunked', '/chunked-slow', '/cond/doc', '/cond/etag-only', '/cond/lastmod-only', '/cond/weak', '/cond/gone',
        '/429', '/429/once?key=a', '/flaky/a?fail=3', '/status/410', '/redirect/chain/5', '/redirect/301', '/redirect/cross/article', '/charset/latin1', '/empty', '/hang', '/reset'];
      return html(res, `<!doctype html><title>Edge fixture</title><h1>Edge fixture</h1><ul>${routes.map((r) => `<li><a href="${r}">${esc(r)}</a></li>`).join('')}</ul>`);
    }
    if (p === '/final') return html(res, '<!doctype html><title>Final</title><h1>Final destination</h1>');

    // ---- slow
    let m = p.match(/^\/delay\/(\d+)$/);
    if (m || p === '/slow') {
      await sleep(m ? Math.min(+m[1], 60000) : state.slowMs);
      return html(res, `<!doctype html><title>Slow</title><h1>Slow response</h1>`);
    }
    if (p === '/slow-body') {
      const ms = clampInt(sp.get('ms'), 200, 0, 10000);
      const chunks = clampInt(sp.get('chunks'), 5, 1, 100);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      for (let i = 1; i <= chunks; i++) {
        if (res.destroyed) return;
        res.write(`chunk ${i}/${chunks}\n`);
        await sleep(ms);
      }
      return res.end('done\n');
    }

    // ---- huge / endless
    if (p === '/huge') {
      const limit = sp.has('bytes') ? clampInt(sp.get('bytes'), 0, 0, 2 ** 40) : Infinity;
      const chunk = Buffer.from('<p>' + 'lorem ipsum dolor sit amet '.repeat(2000) + '</p>\n');
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };
      if (Number.isFinite(limit)) headers['Content-Length'] = limit; // honest length for finite bodies
      res.writeHead(200, headers);
      let sent = 0;
      while (!res.destroyed && sent < limit) {
        const buf = limit - sent < chunk.length ? chunk.subarray(0, limit - sent) : chunk;
        sent += buf.length;
        if (!res.write(buf)) {
          await new Promise((r) => {
            const done = () => { res.off('drain', done); res.off('close', done); r(); };
            res.on('drain', done);
            res.on('close', done);
          });
        }
      }
      return res.end();
    }
    if (p === '/huge-length') {
      // Declares a 5 GB body but only trickles; tests Content-Length pre-checks.
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': 5 * 1024 ** 3 });
      res.write('<p>start</p>');
      while (!res.destroyed) await sleep(200);
      return;
    }

    // ---- compression bombs
    if (p === '/bomb.gz') {
      const body = bomb(clampInt(sp.get('mb'), 100, 1, 1000));
      return send(res, 200, body, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
    }
    if (p === '/bomb-layers') {
      const n = clampInt(sp.get('n'), 7, 1, 20);
      return send(res, 200, bomb(1, n), { 'Content-Type': 'text/html', 'Content-Encoding': Array(n).fill('gzip').join(', ') });
    }
    if (p === '/bomb.deflate') {
      return send(res, 200, zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024), { level: 9 }), { 'Content-Type': 'text/html', 'Content-Encoding': 'deflate' });
    }

    // ---- wrong / missing content types
    if (p === '/type/html-as-plain') return send(res, 200, '<!doctype html><title>Really HTML</title><h1>Really HTML</h1>', { 'Content-Type': 'text/plain' });
    if (p === '/type/html-as-image') return send(res, 200, '<!doctype html><title>Not an image</title><h1>Not an image</h1>', { 'Content-Type': 'image/png' });
    if (p === '/type/png-as-html') return send(res, 200, makePng(8, 8), { 'Content-Type': 'text/html' });
    if (p === '/type/octet-html') return send(res, 200, '<!doctype html><title>Octet</title><h1>Octet stream HTML</h1>', { 'Content-Type': 'application/octet-stream' });
    if (p === '/type/pdf-as-html') return send(res, 200, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n', { 'Content-Type': 'text/html' });
    if (p === '/type/no-type') {
      const body = '<!doctype html><title>No type</title><h1>No type</h1>';
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (p === '/type/json-as-html') return send(res, 200, '{"not":"html"}', { 'Content-Type': 'text/html' });

    // ---- charsets
    if (p === '/charset/latin1') {
      return send(res, 200, Buffer.concat([Buffer.from('<!doctype html><title>caf'), Buffer.from([0xe9]), Buffer.from('</title><p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')]), { 'Content-Type': 'text/html; charset=iso-8859-1' });
    }
    if (p === '/charset/meta-latin1') {
      return send(res, 200, Buffer.concat([Buffer.from('<!doctype html><meta charset="windows-1252"><title>na'), Buffer.from([0xef]), Buffer.from('ve</title>')]), { 'Content-Type': 'text/html' });
    }
    if (p === '/charset/utf8-bom') return send(res, 200, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!doctype html><title>BOM é</title>')]), { 'Content-Type': 'text/html' });

    // ---- chunked
    if (p === '/chunked' || p === '/chunked-slow') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Transfer-Encoding': 'chunked' });
      const parts = ['<!doctype html><title>Chunked</title>', '<h1>Chunked response</h1>', '<p>part three</p>', '<p>part four</p>', '<p>the end</p>'];
      for (const part of parts) {
        res.write(part);
        if (p === '/chunked-slow') await sleep(300);
      }
      return res.end();
    }

    // ---- conditional requests
    m = p.match(/^\/cond\/(doc|etag-only|lastmod-only|weak|gone)$/);
    if (m) {
      const kind = m[1];
      state.condHits.total++;
      if (kind === 'gone' && state.gone) return notFound(res, 'This document has been removed');
      const v = state.condVersion;
      const tag = `v${v}${state.etagSalt}`;
      const etag = kind === 'weak' ? `W/"${tag}"` : `"${tag}"`;
      const lm = lastModified(v);
      const useEtag = kind !== 'lastmod-only';
      const useLm = kind !== 'etag-only' && kind !== 'weak';
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=0, must-revalidate' };
      if (useEtag) headers.ETag = etag;
      if (useLm) headers['Last-Modified'] = lm;
      const inm = req.headers['if-none-match'];
      const ims = req.headers['if-modified-since'];
      let notModified = false;
      if (useEtag && inm) {
        const strip = (s) => s.trim().replace(/^W\//, '');
        notModified = inm === '*' || inm.split(',').some((t) => strip(t) === strip(etag));
      } else if (useLm && ims) {
        notModified = new Date(ims).getTime() >= new Date(lm).getTime();
      }
      if (notModified) {
        state.condHits.notModified++;
        res.writeHead(304, headers);
        return res.end();
      }
      return send(res, 200, `<!doctype html><title>Document v${v}</title><h1>Document version ${v}</h1><p>Body for ${kind}. Version ${v}.</p>`, headers);
    }

    // ---- 429 / 503 / status
    if (p === '/429') {
      const after = clampInt(sp.get('after'), 1, 0, 3600);
      const value = sp.get('date') ? new Date(Date.now() + after * 1000).toUTCString() : String(after);
      return text(res, 'Too Many Requests', 429, { 'Retry-After': value });
    }
    if (p === '/429/once') {
      const key = sp.get('key') || 'default';
      state.once[key] = (state.once[key] || 0) + 1;
      if (state.once[key] === 1) return text(res, 'Too Many Requests', 429, { 'Retry-After': String(clampInt(sp.get('after'), 1, 0, 3600)) });
      return html(res, '<!doctype html><title>OK after 429</title><h1>OK after 429</h1>');
    }
    m = p.match(/^\/flaky\/([\w-]+)$/);
    if (m) {
      const fail = clampInt(sp.get('fail'), 3, 0, 1000);
      const n = (state.flaky[m[1]] = (state.flaky[m[1]] || 0) + 1);
      if (n <= fail) return text(res, `Service Unavailable (${n}/${fail})`, 503, { 'Retry-After': sp.get('after') ?? '1' });
      return html(res, `<!doctype html><title>Recovered</title><h1>Recovered after ${fail} failures</h1><p>Request number ${n}.</p>`);
    }
    m = p.match(/^\/status\/(\d{3})$/);
    if (m) return text(res, `Status ${m[1]}`, +m[1], +m[1] === 405 ? { Allow: 'POST' } : {});

    // ---- redirects
    m = p.match(/^\/redirect\/(301|302|303|307|308)$/);
    if (m) return redirect(res, sp.get('to') || '/final', +m[1]);
    m = p.match(/^\/redirect\/chain\/(\d+)$/);
    if (m) {
      const n = +m[1];
      const fixed = sp.get('code');
      const code = fixed ? +fixed : REDIRECT_CODES[n % REDIRECT_CODES.length];
      const suffix = fixed ? `?code=${fixed}` : '';
      return redirect(res, n <= 1 ? '/final' : `/redirect/chain/${n - 1}${suffix}`, code);
    }
    m = p.match(/^\/redirect\/cross\/(\w+)$/);
    if (m) {
      const target = ctx.urls[m[1]];
      if (!target) return notFound(res, `unknown fixture ${m[1]}`);
      return redirect(res, `${target}/`, 302);
    }
    if (p === '/redirect/loop-a') return redirect(res, '/redirect/loop-b', 302);
    if (p === '/redirect/loop-b') return redirect(res, '/redirect/loop-a', 302);
    if (p === '/redirect/no-location') return send(res, 302, '');
    if (p === '/redirect/relative') return redirect(res, 'final', 302);
    if (p === '/redirect/to') return redirect(res, sp.get('url') || '/final', clampInt(sp.get('code'), 302, 300, 399));

    // ---- misc
    if (p === '/empty') return send(res, 200, '', { 'Content-Type': 'text/html' });
    if (p === '/hang') return void (await new Promise((r) => res.once('close', r)));
    if (p === '/reset') return req.socket.destroy();
    return notFound(res);
  });
  return site;
}
