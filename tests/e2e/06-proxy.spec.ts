import { expect, test } from "@playwright/test";
import { login, mode } from "./helpers";

// These use the mock API's helper endpoints, so they only run against it.
test.skip(() => mode() !== "mock-api", "needs the mock API's helper endpoints");

test("SSE events pass through the proxy unbuffered", async ({ page, baseURL }) => {
  await login(page);
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");

  const res = await fetch(`${baseURL}/api/_mock/slow-sse`, { headers: { cookie, accept: "text/event-stream" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("content-length")).toBeNull();

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const latencies: number[] = [];
  let buf = "";
  while (latencies.length < 3) {
    const { value, done } = await reader.read();
    if (done) break;
    const received = Date.now();
    buf += dec.decode(value, { stream: true });
    for (const m of buf.matchAll(/data: (\{.*?\})\n\n/g)) {
      const { n, sentAt } = JSON.parse(m[1]!) as { n: number; sentAt: number };
      latencies.push(received - sentAt);
      buf = buf.slice((m.index ?? 0) + m[0].length);
      void n;
    }
  }
  await reader.cancel();
  console.log(`SSE latencies through the proxy (ms): ${latencies.join(", ")}`);
  expect(latencies.length).toBeGreaterThanOrEqual(3);
  // The first event is sent 300 ms after connect; it must reach the client within 100 ms of being sent.
  expect(latencies[0]).toBeLessThan(100);
  // Later events (heartbeat) are not held back either.
  for (const l of latencies) expect(l).toBeLessThan(100);
});

test("forged forwarding headers are dropped and the peer IP is stamped", async ({ page, baseURL }) => {
  await login(page);
  const r = await page.request.get(`${baseURL}/api/_mock/headers`, {
    headers: {
      "x-forwarded-for": "6.6.6.6",
      "x-real-ip": "6.6.6.6",
      "x-nocon-client-ip": "6.6.6.6",
      "x-nocon-proxy-secret": "forged",
      "x-forwarded-host": "evil.example",
      "x-ncb-peer-ip": "6.6.6.6",
      "x-custom": "nope",
    },
  });
  expect(r.ok()).toBeTruthy();
  const h = (await r.json()) as Record<string, string>;
  expect(h["x-forwarded-for"]).toBeUndefined();
  expect(h["x-real-ip"]).toBeUndefined();
  expect(h["x-ncb-peer-ip"]).toBeUndefined();
  expect(h["x-custom"]).toBeUndefined();
  expect(h["x-nocon-client-ip"]).toMatch(/127\.0\.0\.1|::1/);
  expect(h["x-nocon-proxy-secret"]).toBe(process.env.E2E_PROXY_SECRET);
  expect(h["x-forwarded-host"]).toBe(new URL(baseURL!).host);
  expect(h["cookie"]).toContain("ncb_session=");
  expect(h["accept-encoding"]).toBe("identity");
});

test("a mutating call without the CSRF header is refused by the API, not hidden by the proxy", async ({ page, baseURL }) => {
  await login(page);
  const r = await page.request.post(`${baseURL}/api/system/connectivity`, { data: { forceOffline: false } });
  expect(r.status()).toBe(403);
  expect(((await r.json()) as { error: string }).error).toBe("csrf");
});
