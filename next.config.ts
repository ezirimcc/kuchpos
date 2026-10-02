import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a compact, self-contained build in .next/standalone that can be
  // uploaded to the hosting server without installing anything there.
  output: "standalone",
};

export default nextConfig;
