import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Request headers forwarded to the API (docs/api.md section 1). Everything else, in particular any
// client-supplied x-forwarded-*, x-real-ip or x-ncb-* header, is dropped.
const FORWARD_REQUEST_HEADERS = [
  "cookie",
  "content-type",
  "content-length",
  "accept",
  "origin",
  "referer",
  "sec-fetch-site",
  "sec-fetch-mode",
  "last-event-id",
  "x-nocon-csrf",
  "idempotency-key",
  "user-agent",
];

const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "cache-control",
  "etag",
  "last-modified",
  "retry-after",
  "vary",
  "location",
  "x-request-id",
];

function upstreamBase(): string {
  return (process.env.API_INTERNAL_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}

async function proxy(req: NextRequest): Promise<Response> {
  const url = `${upstreamBase()}${req.nextUrl.pathname}${req.nextUrl.search}`;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Ask for an uncompressed body: compression would buffer event streams.
  headers.set("accept-encoding", "identity");

  // The real peer address is stamped by instrumentation.ts (`x-ncb-peer-ip`, from the socket). It goes to the API
  // together with the shared secret, so the API only honours it when it really came from this proxy.
  const host = req.headers.get("host") ?? req.nextUrl.host;
  const secret = process.env.NCB_PROXY_SECRET;
  const peer = req.headers.get("x-ncb-peer-ip");
  headers.set("x-forwarded-host", host);
  if (secret) {
    headers.set("x-nocon-proxy-secret", secret);
    if (peer) headers.set("x-nocon-client-ip", peer);
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: req.signal,
    cache: "no-store",
  };
  if (hasBody) {
    init.body = req.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return Response.json(
      {
        error: "internal",
        message: "The NoConBrain server isn't reachable. Check that the server service is running, then try again.",
        details: err instanceof Error ? err.message : undefined,
        requestId: "web-proxy",
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);

  const stream = (upstream.headers.get("content-type") ?? "").startsWith("text/event-stream");
  if (stream) {
    // Pass events straight through: no length, no transforms, and a hint for any proxy in front of us.
    out.delete("content-length");
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  }

  const noBody = req.method === "HEAD" || upstream.status === 204 || upstream.status === 304;
  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export {
  proxy as GET,
  proxy as HEAD,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
