import http from 'node:http';
import { chromium } from 'playwright';

const log = [];            // server-side observations
const results = {};        // client-side reports via postMessage / console

// "Live web" origin: simulates evil.example/ the internet (port 4002)
const web = http.createServer((req, res) => {
  log.push({ server: 'web:4002', url: req.url });
  res.writeHead(200, { 'content-type': 'image/gif', 'access-control-allow-origin': '*' });
  res.end('GIF89a');
}).listen(4002);

// App origin (4000): session cookie HttpOnly, plus a readable cookie, and a privileged API
const app = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/login') {
    res.setHeader('set-cookie', ['sid=SECRET-SESSION; HttpOnly; Path=/; SameSite=Lax', 'theme=dark; Path=/']);
    res.end('ok'); return;
  }
  if (u.pathname === '/api/secret') {
    log.push({ server: 'app:4000', url: req.url, cookie: req.headers.cookie || null, origin: req.headers.origin || null });
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    res.setHeader('access-control-allow-credentials', 'true');
    res.end('TOP-SECRET'); return;
  }
  if (u.pathname === '/shell') { // app chrome with iframe; ?v=variant&sb=sandbox&host=
    const v = u.searchParams.get('v'), sb = u.searchParams.get('sb'), host = u.searchParams.get('host') || 'localhost';
    const sbAttr = sb === 'none' ? '' : ` sandbox="${sb}"`;
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body><h1>shell</h1><iframe id=f${sbAttr} src="http://${host}:4001/a/${v}"></iframe>
<script>window.addEventListener('message',e=>{console.log('REPORT '+JSON.stringify(e.data))});</script>`);
    return;
  }
  res.end('app');
}).listen(4000);

const cspStrict = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors http://localhost:4000 http://127.0.0.1:4000";
const cspScriptsNoConnect = "default-src 'none'; script-src 'unsafe-inline'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors http://localhost:4000";
const cspNone = null;

const evil = `
<h1>archived page</h1><img src="http://localhost:4002/tracker.gif?src=img"><img src="/asset/x.png">
<form id=fm action="http://localhost:4002/form" method="post"><button>x</button></form>
<link rel=stylesheet href="http://localhost:4002/live.css">
<script>
const r = {};
try { r.cookie = document.cookie; } catch(e){ r.cookie='BLOCKED '+e.name; }
const done = [];
function rep(k,v){ r[k]=v; }
try { rep('topLocation', String(top.location.href)); } catch(e){ rep('topLocation','BLOCKED '+e.name); }
try { rep('parentDoc', String(parent.document.title)); } catch(e){ rep('parentDoc','BLOCKED '+e.name); }
try { top.location = 'http://localhost:4002/pwned'; rep('topNav','attempted'); } catch(e){ rep('topNav','BLOCKED '+e.name); }
try { rep('localStorage', String(localStorage.length)); } catch(e){ rep('localStorage','BLOCKED '+e.name); }
(async()=>{
  try { const t = await (await fetch('http://localhost:4000/api/secret',{credentials:'include'})).text(); rep('fetchApp','GOT '+t);} catch(e){ rep('fetchApp','BLOCKED '+e.message); }
  try { await fetch('http://localhost:4002/beacon?fetch',{mode:'no-cors'}); rep('fetchWeb','SENT'); } catch(e){ rep('fetchWeb','BLOCKED '+e.message); }
  try { navigator.sendBeacon('http://localhost:4002/beacon?sb'); } catch(e){}
  try { const w = window.open('http://localhost:4002/popup'); rep('windowOpen', w? 'OPENED':'null'); } catch(e){ rep('windowOpen','BLOCKED'); }
  parent.postMessage(r,'*');
  setTimeout(()=>{ try { document.getElementById('fm').submit(); } catch(e){} }, 600);
})();
</script>`;

const arch = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  log.push({ server: 'archive:4001', url: req.url, host: req.headers.host, cookie: req.headers.cookie || null });
  if (u.pathname.startsWith('/a/')) {
    const v = u.pathname.slice(3);
    const csp = v === 'strict' ? cspStrict : v === 'scripts' ? cspScriptsNoConnect : null;
    res.setHeader('content-type', 'text/html');
    if (csp) res.setHeader('content-security-policy', csp);
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(evil); return;
  }
  res.writeHead(200, { 'content-type': 'image/gif' }); res.end('GIF89a');
}).listen(4001);

const browser = await chromium.launch();
async function run(name, { v, sb, host = 'localhost', shellHost = 'localhost', direct = false }) {
  log.length = 0;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('http://localhost:4000/login');
  const rep = [];
  const consoleMsgs = [];
  page.on('console', m => { const t = m.text(); if (t.startsWith('REPORT ')) rep.push(JSON.parse(t.slice(7))); else consoleMsgs.push(t.slice(0,160)); });
  const popups = []; ctx.on('page', p => popups.push(p.url()));
  if (direct) {
    page.on('console', () => {});
    await page.goto(`http://${host}:4001/a/${v}`);
    await page.waitForTimeout(1500);
    const doc = await page.evaluate(() => document.cookie);
    // collect via evaluate: script already ran; fetch results not posted (no parent). re-read
  } else {
    await page.goto(`http://${shellHost}:4000/shell?v=${v}&sb=${encodeURIComponent(sb)}&host=${host}`);
    await page.waitForTimeout(1800);
  }
  const finalUrl = page.url();
  const out = { name, finalTopUrl: finalUrl, report: rep[0] || null, serverLog: log.filter(l => l.server !== 'archive:4001' || l.url.startsWith('/asset') ).map(l=>JSON.stringify(l)), archiveReqs: log.filter(l=>l.server==='archive:4001').length, popups, consoleBlocked: consoleMsgs.filter(m=>/Refused|blocked|Blocked|sandbox/i.test(m)).slice(0,8) };
  console.log('\n=== ' + name + ' ===\n' + JSON.stringify(out, null, 1));
  await ctx.close();
}

await run('A. no sandbox, no CSP (baseline, same-site other port)', { v: 'none', sb: 'none' });
await run('B. sandbox=allow-scripts (no same-origin), no CSP', { v: 'none', sb: 'allow-scripts' });
await run('C. sandbox=allow-scripts + CSP scripts/no-connect', { v: 'scripts', sb: 'allow-scripts' });
await run('D. sandbox="" (no scripts) + strict CSP', { v: 'strict', sb: '' });
await run('E. no sandbox + strict CSP (CSP only; no script)', { v: 'strict', sb: 'none' });
await run('F. archive on 127.0.0.1:4001, shell on localhost:4000, no sandbox, no CSP (different host)', { v: 'none', sb: 'none', host: '127.0.0.1' });
await browser.close(); web.close(); app.close(); arch.close();
