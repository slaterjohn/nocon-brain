import http from 'node:http'; import { chromium } from 'playwright';
http.createServer((q,r)=>{ r.setHeader('content-type','text/html'); r.end('<a id=l target=_blank rel="noopener noreferrer" href="http://localhost:4002/live">live</a>'); }).listen(4001);
http.createServer((q,r)=>{ const u=new URL(q.url,'http://x'); r.setHeader('content-type','text/html'); r.end(`<iframe src="http://localhost:4001/" sandbox="${u.searchParams.get('sb')}"></iframe>`);}).listen(4000);
http.createServer((q,r)=>{ r.setHeader('content-type','text/html'); r.end('<script>document.title="cookie:"+(()=>{try{localStorage.setItem("a","1");return "storage-ok"}catch(e){return "storage-blocked"}})()</script>live'); }).listen(4002);
const b=await chromium.launch();
for (const sb of ['', 'allow-popups', 'allow-popups allow-popups-to-escape-sandbox']) {
  const ctx=await b.newContext(); const p=await ctx.newPage(); await p.goto('http://localhost:4000/?sb='+encodeURIComponent(sb));
  const pp=ctx.waitForEvent('page',{timeout:1500}).catch(()=>null);
  await p.frames()[1].click('#l'); const n=await pp; if(n){await n.waitForLoadState(); console.log(JSON.stringify(sb),'-> popup opened:',n.url(),'title:',await n.title());} else console.log(JSON.stringify(sb),'-> no popup');
  await ctx.close();
}
await b.close(); process.exit(0);
