import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a compact, self-contained build in .next/standalone that can be
  // uploaded to the hosting server without installing anything there.
  output: "standalone",

  // Do not advertise which software the site runs on.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // The browser's helper program for selling without internet. It must never be served
        // from a stale copy, or an old version could keep running after an update.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          // After one visit over HTTPS, browsers refuse to use plain HTTP for this address for a year.
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          // The app may not be shown inside another website's frame (protects against click-tricking).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
