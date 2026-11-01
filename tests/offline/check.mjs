// Offline acceptance checks. Runs inside the internal Docker network (no route to the internet).
// Env: API_URL, WEB_URL, ARCHIVE_URL, STORAGE_PATH, OFFLINE_ADMIN_PASSWORD
const API = process.env.API_URL ?? "http://server:3001";
const WEB = process.env.WEB_URL ?? "http://web:3000";
const ARCHIVE = process.env.ARCHIVE_URL ?? "http://server:3002";
const STORAGE_PATH = process.env.STORAGE_PATH ?? "/volumes/default";
const PASSWORD = process.env.OFFLINE_ADMIN_PASSWORD ?? "offline-test-password-1";
const USERNAME = "admin";

const results = [];
let cookie = "";

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.message ?? e).slice(0, 200) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function req(path, { method = "GET", body, headers = {}, base = API } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (method !== "GET" && method !== "HEAD") h["x-nocon-csrf"] = "1";
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  const set = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("ncb_session="));
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const must = (r, what, ok = [200]) => assert(ok.includes(r.status), `${what}: HTTP ${r.status} ${r.text.slice(0, 120)}`);

// ---- reachability --------------------------------------------------------------------------
await check("server health (API)", async () => {
  const r = await req("/api/system/health");
  must(r, "health");
  assert(r.json?.status === "ok", `status=${r.json?.status}`);
});
await check("web health", async () => {
  const r = await req("/healthz", { base: WEB });
  must(r, "web /healthz");
});
await check("web proxies /api to server", async () => {
  const r = await req("/api/setup/status", { base: WEB });
  must(r, "setup status via web");
  assert(typeof r.json?.complete === "boolean", `unexpected body ${r.text.slice(0, 80)}`);
});
await check("archive listener /__health", async () => {
  const r = await req("/__health", { base: ARCHIVE });
  must(r, "archive health");
  assert(/sandbox/.test(r.headers.get("content-security-policy") ?? ""), "archive response lacks the sandbox CSP");
  assert(!r.headers.get("set-cookie"), "archive listener set a cookie");
});

// ---- first-run setup through the API --------------------------------------------------------
await check("setup: create administrator", async () => {
  const st = await req("/api/setup/status");
  assert(st.json?.adminExists === false && st.json?.complete === false, `not a fresh install: ${st.text.slice(0, 100)}`);
  const r = await req("/api/setup/admin", { method: "POST", body: { username: USERNAME, password: PASSWORD } });
  must(r, "create admin");
  assert(cookie, "no session cookie after creating the administrator");
});
await check("setup: validate storage", async () => {
  const r = await req("/api/setup/storage/validate", { method: "POST", body: { path: STORAGE_PATH } });
  must(r, "validate storage");
  assert(r.json?.ok === true, `validation failed: ${r.text.slice(0, 160)}`);
  return `free ${(r.json.freeBytes / 2 ** 30).toFixed(1)} GiB, warnings: ${(r.json.warnings ?? []).join(",") || "none"}`;
});
await check("setup: register storage", async () => {
  const r = await req("/api/setup/storage", { method: "POST", body: { path: STORAGE_PATH, name: "Offline test storage" } });
  must(r, "register storage");
  assert(r.json?.volume?.state === "online", `volume state ${r.json?.volume?.state}`);
});
await check("setup: resource profile", async () => {
  const r = await req("/api/setup/profile", { method: "POST", body: { profile: "pi-lite" } });
  must(r, "profile");
  assert(r.json?.profile === "pi-lite", r.text.slice(0, 100));
});
await check("setup: skip providers", async () => {
  const r = await req("/api/setup/providers", { method: "POST", body: { skip: true } });
  must(r, "providers");
  assert(r.json?.skipped === true, r.text.slice(0, 100));
});
await check("setup: complete", async () => {
  const r = await req("/api/setup/complete", { method: "POST" });
  must(r, "complete");
  assert(r.json?.complete === true, r.text.slice(0, 100));
  const st = await req("/api/setup/status");
  assert(st.json?.complete === true && st.json?.storageConfigured === true, st.text.slice(0, 120));
});

// ---- signed-in use -------------------------------------------------------------------------
await check("login", async () => {
  cookie = "";
  const r = await req("/api/auth/login", { method: "POST", body: { username: USERNAME, password: PASSWORD } });
  must(r, "login");
  assert(cookie, "no session cookie");
  const me = await req("/api/auth/me");
  must(me, "me");
  assert(JSON.stringify(me.json).includes(USERNAME), `me: ${me.text.slice(0, 100)}`);
});
await check("login with a wrong password is refused", async () => {
  const saved = cookie;
  cookie = "";
  const r = await req("/api/auth/login", { method: "POST", body: { username: USERNAME, password: "not-the-password" } });
  cookie = saved;
  assert(r.status === 401, `HTTP ${r.status}`);
});
await check("dashboard", async () => {
  const r = await req("/api/system/dashboard");
  must(r, "dashboard");
  assert(r.json?.storage && r.json?.jobs, `shape: ${r.text.slice(0, 100)}`);
  assert(r.json.storage.availableBytes > 0, "no storage available");
  return `avail ${(r.json.storage.availableBytes / 2 ** 30).toFixed(1)} GiB, connectivity ${r.json.connectivity}`;
});
await check("settings", async () => {
  const r = await req("/api/settings");
  must(r, "settings");
  assert(r.json && typeof r.json === "object", "no settings object");
  assert(r.json.resources?.profile === "pi-lite", `resources.profile=${r.json.resources?.profile}`);
});
await check("system status: worker pool alive", async () => {
  const r = await req("/api/system/status");
  must(r, "status");
  assert(Array.isArray(r.json?.workerPool), "no workerPool");
  assert(r.json.workerPool.every((w) => w.state !== "failed"), `pool ${JSON.stringify(r.json.workerPool).slice(0, 120)}`);
  return `${r.json.architecture} node ${r.json.node}, ${r.json.workerPool.length} worker(s), rss ${r.json.memory.rssMb} MB`;
});
await check("connectivity: no internet is not reported as online", async () => {
  const r = await req("/api/system/connectivity");
  must(r, "connectivity");
  // With no probe configured the state is "unknown" until a real request fails, never "online".
  assert(r.json?.state === "unknown" || r.json?.state === "offline", `state=${r.json?.state} source=${r.json?.source}`);
  return `state=${r.json.state} source=${r.json.source}`;
});
await check("connectivity: work-offline switch", async () => {
  const on = await req("/api/system/connectivity", { method: "POST", body: { forceOffline: true } });
  must(on, "force offline");
  assert(on.json?.state === "offline" && on.json?.source === "forced", on.text.slice(0, 100));
  const off = await req("/api/system/connectivity", { method: "POST", body: { forceOffline: false } });
  must(off, "unforce");
  assert(off.json?.source !== "forced", off.text.slice(0, 100));
});
await check("web serves the app shell with no external references", async () => {
  const r = await req("/login", { base: WEB });
  assert([200, 307, 308].includes(r.status), `HTTP ${r.status}`);
  const page = r.status === 200 ? r.text : (await req(r.headers.get("location") ?? "/", { base: WEB })).text;
  const ext = [...page.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith(WEB));
  assert(ext.length === 0, `external references: ${ext.slice(0, 3).join(", ")}`);
});

// ---- isolation -----------------------------------------------------------------------------
for (const url of ["https://example.com", "http://1.1.1.1"]) {
  await check(`no internet from the test container (${url})`, async () => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch {
      return "request failed as expected";
    }
    throw new Error(`reached ${url}`);
  });
}

// ---- report --------------------------------------------------------------------------------
const w = Math.max(...results.map((r) => r.name.length));
console.log(`\nRESULT  ${"CHECK".padEnd(w)}  DETAIL`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}    ${r.name.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
