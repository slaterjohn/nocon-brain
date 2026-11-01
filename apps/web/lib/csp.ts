// The app's Content-Security-Policy, built per request by proxy.ts. Everything is 'self' except `frame-src`, which also
// allows the archive listener (a different port, hence a different origin) so archived pages can be shown in a frame.
// 'unsafe-inline' for scripts is needed for Next's inline hydration bootstrap and the theme-init snippet; the app uses no
// per-request nonces (they would force every page to render dynamically).

export function archiveOriginFor(host: string | null, protocol: string, env: Record<string, string | undefined> = process.env): string | null {
  const fixed = env.NCB_ARCHIVE_PUBLIC_URL;
  if (fixed) {
    try {
      return new URL(fixed).origin;
    } catch {
      /* fall through to the derived address */
    }
  }
  const m = host ? /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(host.trim()) : null;
  if (!m) return null;
  const port = /^\d{1,5}$/.test(env.NCB_ARCHIVE_PORT ?? "") ? env.NCB_ARCHIVE_PORT : "3002";
  return `${protocol === "https:" ? "https:" : "http:"}//${m[1]}:${port}`;
}

export function buildCsp(archiveOrigin: string | null, production: boolean): string {
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "script-src 'self' 'unsafe-inline'" + (production ? "" : " 'unsafe-eval'"),
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "font-src 'self'",
    `frame-src 'self'${archiveOrigin ? ` ${archiveOrigin}` : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
}
