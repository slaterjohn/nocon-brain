import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/[...path]/route";

// H-03: the web app's /api proxy forwards the API's own security headers and nothing the browser sent that it should not.

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NCB_PROXY_SECRET;
});

function stubUpstream(headers: Record<string, string>, body = "{}") {
  const seen: { url: string; headers: Headers }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers) });
    return new Response(body, { status: 200, headers });
  });
  return seen;
}

describe("/api proxy", () => {
  it("passes the API's Content-Security-Policy through", async () => {
    stubUpstream({ "content-type": "application/json", "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-frame-options": "DENY" });
    const res = await GET(new NextRequest("http://localhost:3000/api/system/health"));
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("drops client-supplied forwarding headers and stamps the secret and peer only itself", async () => {
    process.env.NCB_PROXY_SECRET = "s".repeat(32);
    const seen = stubUpstream({ "content-type": "application/json" });
    await POST(new NextRequest("http://localhost:3000/api/auth/login", {
      method: "POST", body: "{}",
      headers: { "x-nocon-proxy-secret": "forged", "x-nocon-client-ip": "10.0.0.1", "x-forwarded-for": "10.0.0.2", "x-real-ip": "10.0.0.3", "x-ncb-peer-ip": "203.0.113.5", "content-type": "application/json", cookie: "ncb_session=abc" },
    }));
    const h = seen[0]!.headers;
    expect(h.get("x-nocon-proxy-secret")).toBe("s".repeat(32));
    expect(h.get("x-nocon-client-ip")).toBe("203.0.113.5"); // the socket's address, not the header the client wrote
    expect(h.get("x-forwarded-for")).toBeNull();
    expect(h.get("x-real-ip")).toBeNull();
    expect(h.get("cookie")).toBe("ncb_session=abc");
  });

  it("builds the upstream URL from the path it was given, never from a header", async () => {
    const seen = stubUpstream({ "content-type": "application/json" });
    await GET(new NextRequest("http://localhost:3000/api/settings?x=1", { headers: { "x-forwarded-host": "evil.example", "x-original-url": "http://169.254.169.254/" } }));
    expect(seen[0]!.url).toBe("http://localhost:3001/api/settings?x=1");
  });
});
