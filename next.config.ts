import type { NextConfig } from "next";

const ALLOWED_ORIGIN = 'vscode-file://vscode-app';

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply these headers specifically to the /api/auth/verify path
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
      {
        // Handle OPTIONS preflight requests for the same path
        source: '/api/auth/verify',
        headers: [
          // Add headers needed for the OPTIONS response specifically
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
            value: 'GET, OPTIONS',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type',
          },
        ],
        // This configuration ensures that only OPTIONS requests match this entry
        has: [
          {
            type: 'method',
            key: 'Method',
            value: 'OPTIONS',
          }
        ]
      }
    ];
  },
};

export default nextConfig;
