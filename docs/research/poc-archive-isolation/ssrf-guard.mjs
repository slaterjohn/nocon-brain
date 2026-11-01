import { Agent, request } from 'undici';
import ipaddr from 'ipaddr.js';
import dns from 'node:dns';
import http from 'node:http';
import zlib from 'node:zlib';

const BLOCK = new Set(['unspecified','broadcast','multicast','linkLocal','loopback','carrierGradeNat','private','reserved','uniqueLocal','ipv4Mapped','rfc6145','rfc6052','6to4','teredo']);
function isBlocked(addr) {
  let a = ipaddr.parse(addr);
  if (a.kind()==='ipv6' && a.isIPv4MappedAddress()) a = a.toIPv4Address();
  return a.range() !== 'unicast';   // only globally routable unicast allowed
}
const lookups = [];
const safeAgent = new Agent({
  connect: { lookup(host, opts, cb) {
    dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
      lookups.push(host);
      if (err) return cb(err);
      const ok = addrs.filter(a => !isBlocked(a.address));
      if (!ok.length) return cb(Object.assign(new Error('SSRF blocked '+host+' -> '+addrs.map(a=>a.address)), {code:'ESSRF'}));
      if (opts.all) return cb(null, ok); cb(null, ok[0].address, ok[0].family);
    });
  }},
  bodyTimeout: 5000, headersTimeout: 5000,
  maxResponseSize: 1_000_000
});
for (const u of ['http://localhost:9/', 'http://127.0.0.1:9/', 'http://[::1]:9/', 'http://2130706433:9/', 'http://0x7f.1:9/', 'http://[::ffff:127.0.0.1]:9/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1:9/']) {
  const norm = new URL(u).hostname;
  try { await request(u, { dispatcher: safeAgent, headersTimeout: 2000 }); console.log(u, '(WHATWG host', norm+')', '-> CONNECTED?!'); }
  catch (e) { console.log(u.padEnd(45), 'host='+norm.padEnd(18), 'lookupCalled='+lookups.includes(norm), '->', e.code||e.name, e.message.slice(0,50)); }
}
console.log('--- pre-check of literal IPs after WHATWG normalisation:');
for (const h of ['127.0.0.1','[::1]','[::ffff:7f00:1]','169.254.169.254','100.64.0.1','93.184.216.34','10.1.2.3','192.168.1.5','fd00::1','[2606:4700::1111]']) {
  const bare=h.replace(/[\[\]]/g,''); console.log(h.padEnd(20), ipaddr.parse(bare).range(), isBlocked(bare)?'BLOCK':'allow');
}
// decompression bomb: 100 MB of zeros gzip'd (~100KB)
const bomb = zlib.gzipSync(Buffer.alloc(100*1024*1024));
console.log('--- bomb compressed bytes', bomb.length);
const srv = http.createServer((q,r)=>{ r.writeHead(200,{'content-encoding':'gzip','content-type':'text/html'}); r.end(bomb); }).listen(4555);
const plain = new Agent({ maxResponseSize: 1_000_000 });
try { const res = await request('http://127.0.0.1:4555/', { dispatcher: plain }); const b = await res.body.text(); console.log('request() does NOT decompress; got', b.length, 'raw chars (gzip bytes)'); } catch(e){ console.log('request err', e.code, e.message); }
// fetch() decompresses; count bytes with cap via reader
const r = await fetch('http://127.0.0.1:4555/', { dispatcher: plain }).catch(e=>e);
if (r instanceof Error) console.log('fetch with maxResponseSize err:', r.cause?.code||r.message);
let total=0; try { const f = await fetch('http://127.0.0.1:4555/'); const rd=f.body.getReader(); for(;;){const {done,value}=await rd.read(); if(done)break; total+=value.length; if(total>2_000_000){ await rd.cancel(); console.log('manual cap hit at', total,'decoded bytes (aborted)'); break;} } } catch(e){ console.log('manual', e.message); }
srv.close(); await safeAgent.close(); await plain.close();
