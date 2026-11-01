import path from "node:path";
import type { NextConfig } from "next";

// Strict CSP for the app itself. Everything is 'self': no external scripts, styles, fonts, images or connections.
// 'unsafe-inline' for scripts is needed for Next's inline hydration bootstrap and the theme-init snippet; the app
// uses no per-request nonces (they would force every page to render dynamically). The archive listener is a
// different origin and is not allowed as a frame source until A-14 widens `frame-src` to that origin.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"),
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

const config: NextConfig = {
  output: "standalone",
  // Lets the E2E suite build into its own directory so it never races other builds of this app.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  // Response compression buffers server-sent events. The /api proxy must stream unbuffered, so it is off here;
  // a reverse proxy in front can compress.
  compress: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Content-Security-Policy", value: CSP },
        ],
      },
    ];
  },
};

export default config;
