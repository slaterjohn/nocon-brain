# Proof-of-concept scripts for crawling-rendering.md

Throwaway scripts. Run with `npm i playwright@1.64.1 && npx playwright install chromium` then `node matrix.mjs` (ports 4000-4002 must be free).
`ssrf-guard.mjs` needs `undici@8` and `ipaddr.js` on Node >= 22.19. `sqlite-queue-bench.mjs` needs `better-sqlite3@13` on Node 24.
