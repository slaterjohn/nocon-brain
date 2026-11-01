import http from 'node:http';
import { chromium } from 'playwright';
const arch = http.createServer((q,r)=>{ r.setHeader('content-type','text/html'); r.end('<a id=l target=_top href="http://localhost:4002/top-nav">click</a>'); }).listen(4001);
const app = http.createServer((q,r)=>{ const u=new URL(q.url,'http://x'); r.setHeader('content-type','text/html'); r.end(`<iframe src="http://localhost:4001/" ${u.searchParams.get('sb')==null?'':'sandbox="'+u.searchParams.get('sb')+'"'}></iframe>`);}).listen(4000);
http.createServer((q,r)=>r.end('landed')).listen(4002);
const b = await chromium.launch();
for (const sb of [null,'','allow-scripts','allow-top-navigation-by-user-activation','allow-popups']) {
  const p = await b.newPage();
  await p.goto('http://localhost:4000/'+(sb===null?'':'?sb='+sb));
  const f = p.frames()[1];
  await f.click('#l'); await p.waitForTimeout(500);
  console.log('sandbox='+JSON.stringify(sb), '-> top url:', p.url());
  await p.close();
}
await b.close(); process.exit(0);
