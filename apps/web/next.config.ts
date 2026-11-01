import path from "node:path";
import type { NextConfig } from "next";

// The Content-Security-Policy is set per request by proxy.ts (lib/csp.ts): `frame-src` must name the archive listener's
// origin, which is a deployment setting. The other headers are static.

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
        ],
      },
    ];
  },
};

export default config;
