import type { NextConfig } from "next";

const ALLOWED_ORIGIN = 'vscode-file://vscode-app';

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply these headers specifically to the /api/auth/verify path for GET requests
        source: '/api/auth/verify',
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
            value: 'GET, OPTIONS', // Allow GET and preflight OPTIONS
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type', // Allow common headers
          },
        ],
      },
    ];
  },
};

export default nextConfig;
