export const dynamic = "force-dynamic";

/** Docker healthcheck for the web container. Does not touch the API. */
export function GET() {
  return new Response("ok", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}
