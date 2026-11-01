import http from "node:http";

/**
 * Records the real TCP peer address of every incoming request in `x-ncb-peer-ip`.
 *
 * Why this exists: Next sets `x-forwarded-for` from the socket only when the header is absent, so a client-supplied
 * value passes through untouched. Route handlers have no access to the socket, so the peer address is stamped onto
 * the Node request before Next sees it, overwriting anything the client sent under that name. The /api proxy forwards
 * it to the server as `x-nocon-client-ip` together with the shared proxy secret.
 */
export function stampPeerIp() {
  const proto = http.Server.prototype as unknown as { emit: (...a: unknown[]) => boolean; __ncb_peer?: boolean };
  if (proto.__ncb_peer) return;
  proto.__ncb_peer = true;
  const original = proto.emit;
  proto.emit = function (this: unknown, event: unknown, ...args: unknown[]) {
    if (event === "request") {
      const req = args[0] as { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } };
      delete req.headers["x-ncb-peer-ip"];
      const addr = req.socket?.remoteAddress;
      if (addr) req.headers["x-ncb-peer-ip"] = addr;
    }
    return original.call(this, event, ...args);
  };
}
