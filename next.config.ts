import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ['node:sqlite'],
};

export default nextConfig;
