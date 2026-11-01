// Site 6: SSRF bait. Redirects and links aimed at addresses an SSRF guard must refuse.
//
// Loopback-style targets point at THIS server's own port with a /canary path, so a guard that fails
// opens a real connection and /__canary (hit count) goes above zero. Other targets use no port or port 80,
// so they either fail to connect or hit nothing.
import { startSite, esc, html, text, json, redirect, notFound } from './lib.mjs';

/** name -> { url, needsDns?, hitsCanary? } */
export function baitTargets(port) {
  const c = `:${port}/canary`;
  return {
    loopback: { url: `http://127.0.0.1${c}`, hitsCanary: true },
    loopbackNoPort: { url: 'http://127.0.0.1/' },
    ipv6Loopback: { url: `http://[::1]${c}` },
    metadata: { url: 'http://169.254.169.254/latest/meta-data/' },
    private10: { url: 'http://10.0.0.1/' },
    private172: { url: 'http://172.16.0.1/' },
    private192: { url: 'http://192.168.1.1/' },
    cgnat: { url: 'http://100.64.0.1/' },
    decimal: { url: `http://2130706433${c}`, hitsCanary: true },
    hex: { url: `http://0x7f.1${c}`, hitsCanary: true },
    hexFull: { url: `http://0x7f000001${c}`, hitsCanary: true },
    octal: { url: `http://0177.0.0.1${c}`, hitsCanary: true },
    ipv4Mapped: { url: `http://[::ffff:127.0.0.1]${c}` },
    ipv4MappedHex: { url: `http://[::ffff:7f00:1]${c}` },
    unspecified: { url: `http://0.0.0.0${c}`, hitsCanary: true },
    localhost: { url: `http://localhost${c}`, hitsCanary: true },
    // Optional: needs real DNS. *.localtest.me resolves to 127.0.0.1 on the public internet,
    // so these only work when a resolver is available; offline tests should use a stub resolver instead.
    localtestMe: { url: `http://fixture.localtest.me${c}`, needsDns: true, hitsCanary: true },
    nipIo: { url: `http://127.0.0.1.nip.io${c}`, needsDns: true, hitsCanary: true },
    userinfoTrick: { url: `http://example.com@127.0.0.1${c}`, hitsCanary: true },
    fileScheme: { url: 'file:///etc/passwd' },
    ftpScheme: { url: 'ftp://127.0.0.1/' },
    gopher: { url: 'gopher://127.0.0.1:6379/_PING' },
    oddPort: { url: 'http://127.0.0.1:22/' },
  };
}

export async function startSsrfBait() {
  let canary = 0;
  const site = await startSite('ssrfBait', (req, res, url) => {
    const p = url.pathname;
    const targets = baitTargets(site.port);

    if (p === '/canary') {
      canary++;
      return text(res, 'CANARY: the SSRF guard did not stop this request');
    }
    if (p === '/__canary') return json(res, { hits: canary });
    if (p === '/__canary/reset') {
      canary = 0;
      return json(res, { hits: 0 });
    }
    if (p === '/__targets') return json(res, targets);

    if (p === '/') {
      return html(res, `<!doctype html><title>SSRF bait</title><h1>SSRF bait</h1>
<h2>Redirects</h2><ul>${Object.keys(targets).map((k) => `<li><a href="/redirect/${k}">/redirect/${k}</a></li>`).join('')}</ul>
<h2>Pages</h2><ul><li><a href="/page/links">links</a></li><li><a href="/page/assets">assets</a></li><li><a href="/page/meta-refresh">meta refresh</a></li><li><a href="/page/css">css</a></li></ul>`);
    }
    let m = p.match(/^\/redirect\/(\w+)$/);
    if (m) {
      const t = targets[m[1]];
      if (!t) return notFound(res);
      return redirect(res, t.url, +url.searchParams.get('code') || 302);
    }
    // A redirect hop that looks harmless then points inside (for hop-by-hop revalidation).
    if (p === '/redirect/via-public') return redirect(res, `/redirect/loopback`, 302);
    if (p === '/redirect/to-public-ok') return redirect(res, '/ok', 302);
    if (p === '/ok') return html(res, '<!doctype html><title>OK</title><h1>Harmless public page</h1>');

    if (p === '/page/links') {
      return html(res, `<!doctype html><title>Links to private addresses</title><main><article><h1>Links to private addresses</h1>
<ul>${Object.entries(targets).map(([k, t]) => `<li><a href="${esc(t.url)}">${esc(k)}</a></li>`).join('')}</ul></article></main>`);
    }
    if (p === '/page/assets') {
      return html(res, `<!doctype html><title>Assets on private addresses</title><main><h1>Assets</h1>
<img src="${targets.metadata.url}x.png"><script src="${targets.loopback.url}"></script>
<link rel="stylesheet" href="${targets.private10.url}style.css"><iframe src="${targets.decimal.url}"></iframe>
<img srcset="${targets.hex.url} 1x, ${targets.cgnat.url}hi.png 2x"></main>`);
    }
    if (p === '/page/meta-refresh') {
      return html(res, `<!doctype html><meta http-equiv="refresh" content="0;url=${esc(targets.loopback.url)}"><title>Refresh</title><p>Redirecting</p>`);
    }
    if (p === '/page/css') {
      return html(res, `<!doctype html><title>CSS</title><link rel="stylesheet" href="/page/bait.css"><main><h1>CSS bait</h1></main>`);
    }
    if (p === '/page/bait.css') {
      return text(res, `@import url("${targets.metadata.url}evil.css");\nbody { background: url(${targets.loopback.url}); }\n@font-face { font-family: X; src: url("${targets.private192.url}f.woff2"); }\n`, 200, { 'Content-Type': 'text/css' });
    }
    return notFound(res);
  });
  return site;
}
