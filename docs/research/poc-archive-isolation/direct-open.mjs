import http from 'node:http'; import { chromium } from 'playwright';
const seen=[];
http.createServer((q,r)=>{ seen.push({url:q.url,cookie:q.headers.cookie||null,origin:q.headers.origin||null,site:q.headers['sec-fetch-site']}); r.setHeader('set-cookie','sid=SECRET; HttpOnly; Path=/'); r.setHeader('access-control-allow-origin',q.headers.origin||'*'); r.setHeader('access-control-allow-credentials','true'); r.end('SECRET-DATA'); }).listen(4000);
const html=`<title>init</title><script>
let o=[]; try{o.push('cookie='+document.cookie)}catch(e){o.push('cookie=BLOCKED')}
fetch('http://localhost:4000/api',{credentials:'include'}).then(r=>r.text()).then(t=>o.push('fetch=GOT '+t),e=>o.push('fetch=BLOCKED')).finally(()=>{document.title=o.join(' | ')});
</script>`;
http.createServer((q,r)=>{ const v=q.url.slice(1); r.setHeader('content-type','text/html'); if(v==='sandbox') r.setHeader('content-security-policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'"); if(v==='sandbox-noconnect') r.setHeader('content-security-policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'"); r.end(html); }).listen(4001);
const b=await chromium.launch();
for (const v of ['plain','sandbox','sandbox-noconnect']) {
  seen.length=0; const c=await b.newContext(); const p=await c.newPage();
  await p.goto('http://localhost:4000/seed'); // sets HttpOnly cookie on localhost (all ports)
  await p.goto('http://localhost:4001/'+v); await p.waitForTimeout(800);
  console.log(v.padEnd(18),'title =>',await p.title(),'\n   app saw:',JSON.stringify(seen.filter(s=>s.url==='/api')));
  await c.close();
}
await b.close(); process.exit(0);
