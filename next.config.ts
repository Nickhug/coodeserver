import type { NextConfig } from "next";

const ALLOWED_ORIGIN = 'vscode-file://vscode-app';

const nextConfig: NextConfig = {
  // Enable standalone output mode for Docker optimization
  output: 'standalone',
  
  async headers() {
    return [
      {
        // Apply CORS headers to all API routes for testing
        source: '/api/:path*', // Broaden the source path
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: ALLOWED_ORIGIN,
          },
          {
            key: 'Access-Control-Allow-Credentials',
            value: 'true',
          },
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET, POST, PUT, DELETE, OPTIONS', // Allow common methods
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type, Authorization', // Allow common headers + Auth
          },
        ],
      },
    ];
  },
};

export default nextConfig;
