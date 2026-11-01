import Better from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const schema = `
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, host TEXT NOT NULL, url TEXT NOT NULL UNIQUE, priority INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, run_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, worker TEXT);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state, run_at, priority DESC, id);
CREATE INDEX IF NOT EXISTS jobs_lease ON jobs(lease_until) WHERE state='running';`;
const claimSql = `UPDATE jobs SET state='running', lease_until=?, worker=?, attempts=attempts+1
 WHERE id = (SELECT id FROM jobs WHERE state='queued' AND run_at<=? ORDER BY priority DESC, id LIMIT 1) RETURNING id,url`;
async function bench(name, open, tx) {
  for (const f of fs.readdirSync('.').filter(f=>f.startsWith('q-'))) fs.unlinkSync(f);
  const db = open('q-'+name+'.db'); db.exec(schema);
  const ins = db.prepare('INSERT OR IGNORE INTO jobs(host,url,priority) VALUES (?,?,?)');
  let t = performance.now();
  tx(db, () => { for (let i=0;i<50000;i++) ins.run('h'+(i%500)+'.example', 'https://h'+(i%500)+'.example/p/'+i, i%5); });
  const tIns = performance.now()-t;
  const claim = db.prepare(claimSql), done = db.prepare("UPDATE jobs SET state='done', lease_until=NULL WHERE id=?");
  const now = Date.now(); t = performance.now(); let n=0;
  for (let i=0;i<5000;i++) { const r = claim.get(now+60000, 'w1', now); if(!r) break; done.run(r.id); n++; }   // each statement autocommits
  const tClaim = performance.now()-t;
  // reaper
  t = performance.now(); db.prepare("UPDATE jobs SET state='queued', lease_until=NULL WHERE state='running' AND lease_until<?").run(now+120000); const tReap=performance.now()-t;
  console.log(`${name.padEnd(14)} insert 50k in 1 tx: ${tIns.toFixed(0)}ms | claim+done x${n} autocommit: ${tClaim.toFixed(0)}ms (${(tClaim/n).toFixed(3)} ms/job) | reaper ${tReap.toFixed(1)}ms | wal=${fs.existsSync('q-'+name+'.db-wal')?(fs.statSync('q-'+name+'.db-wal').size/1048576).toFixed(1)+'MB':'-'}`);
  db.close();
}
await bench('better-sqlite3', p=>new Better(p), (db,fn)=>db.transaction(fn)());
await bench('node:sqlite', p=>new DatabaseSync(p), (db,fn)=>{db.exec('BEGIN'); try{fn(); db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}});
console.log(process.version, process.arch, 'sqlite', new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v);
