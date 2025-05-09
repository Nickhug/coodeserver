/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@repo/auth", "@repo/types", "@repo/logger"],
  experimental: {
    serverComponentsExternalPackages: []
  }
};

module.exports = nextConfig; 