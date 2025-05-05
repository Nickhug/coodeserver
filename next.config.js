/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async headers() {
    return [
      {
        // Apply these headers to all API routes
        source: "/api/:path*",
        headers: [
          // Allow requests from VS Code extension origin
          {
            key: "Access-Control-Allow-Origin",
            // IMPORTANT: Must be the specific origin, not '*'
            value: "vscode-file://vscode-app", 
          },
          // Allow credentials (cookies, authorization headers, etc.)
          {
            key: "Access-Control-Allow-Credentials",
            value: "true",
          },
          // Allowed methods
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, POST, OPTIONS, HEAD",
          },
          // Allowed headers
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization", 
          },
        ],
      },
    ];
  },
  // You might have other Next.js config options here
  // For example:
  // experimental: {
  //   serverActions: true, 
  // },
};

module.exports = nextConfig;
