// Shared helpers for the fixture sites. Built-in Node modules only.
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const HOST = '127.0.0.1';

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Small deterministic string hash (not cryptographic). */
export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- responses
export function send(res, status, body = '', headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}
export const html = (res, body, status = 200, headers = {}) =>
  send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
export const text = (res, body, status = 200, headers = {}) =>
  send(res, status, body, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
export const json = (res, obj, status = 200, headers = {}) =>
  send(res, status, JSON.stringify(obj, null, 2), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
export const xml = (res, body, status = 200, headers = {}, type = 'application/xml') =>
  send(res, status, body, { 'Content-Type': `${type}; charset=utf-8`, ...headers });
export const notFound = (res, msg = 'Not found') =>
  html(res, `<!doctype html><title>404</title><h1>404</h1><p>${esc(msg)}</p>`, 404);
export const redirect = (res, location, status = 302, extra = {}) =>
  send(res, status, '', { Location: location, ...extra });

/** Send a body with a strong ETag; answers 304 to a matching If-None-Match. */
export function sendCond(req, res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const etag = `"${sha1(buf).slice(0, 16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, ...stripEntity(headers) });
    return res.end();
  }
  send(res, status, buf, { ETag: etag, ...headers });
}
const stripEntity = (h) => {
  const o = { ...h };
  delete o['Content-Length'];
  return o;
};

export const gzip = (b) => zlib.gzipSync(b, { level: 9 });

// -------------------------------------------------------------------- PNG
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const pngCache = new Map();
/** Deterministic tiny RGB PNG: horizontal gradient from `rgb` to a lighter shade. */
export function makePng(w, h, rgb = [40, 90, 200]) {
  const key = `${w}x${h}-${rgb.join(',')}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const f = w > 1 ? x / (w - 1) : 0;
      for (let c = 0; c < 3; c++) raw[o + 1 + x * 3 + c] = Math.round(rgb[c] + (255 - rgb[c]) * 0.5 * f);
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  pngCache.set(key, png);
  return png;
}
/** ICO file wrapping a PNG (valid for modern browsers). */
export function makeIco(rgb = [200, 80, 40]) {
  const png = makePng(16, 16, rgb);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = 16;
  head[7] = 16;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}
export const hexToRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

// ------------------------------------------------------------------ server
/**
 * Start a site on a random free port. The handler receives (req, res, url).
 * Every site also gets:
 *   GET /__health        -> {"ok":true,"name":...}
 *   GET /__log           -> {entries:[{n,method,url,ua,t,inFlight}], maxInFlight, total}
 *   GET /__log/reset     -> clears the log
 * `t` is milliseconds since the site started (monotonic), so tests can check spacing.
 */
export async function startSite(name, handler, { host = HOST, port = 0, logCap = 20000 } = {}) {
  const t0 = process.hrtime.bigint();
  const state = { entries: [], total: 0, inFlight: 0, maxInFlight: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    if (url.pathname === '/__health') return json(res, { ok: true, name });
    if (url.pathname === '/__log') {
      return json(res, { entries: state.entries, maxInFlight: state.maxInFlight, total: state.total });
    }
    if (url.pathname === '/__log/reset') {
      state.entries.length = 0;
      state.total = 0;
      state.maxInFlight = 0;
      return json(res, { ok: true });
    }
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    state.total++;
    if (state.entries.length < logCap) {
      state.entries.push({
        n: state.total,
        method: req.method,
        url: req.url,
        ua: req.headers['user-agent'] || null,
        t: Number((process.hrtime.bigint() - t0) / 1000000n),
        inFlight: state.inFlight,
      });
    }
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        state.inFlight--;
      }
    };
    res.on('close', finish);
    try {
      await handler(req, res, url);
    } catch (err) {
      if (!res.headersSent) text(res, `fixture error: ${err.stack}`, 500);
      else res.destroy();
    }
  });
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const p = server.address().port;
  return {
    name,
    server,
    port: p,
    origin: `http://${host}:${p}`,
    state,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

export function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (d) => {
      n += d.length;
      if (n > limit) return reject(new Error('body too large'));
      parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
