/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Merged env block from next.config.ts
  env: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    // Add other NEXT_PUBLIC_ variables needed during build here, if any
  },
  async headers() {
    return [
      {
        // Apply these headers to all API routes
        source: "/api/:path*",
        headers: [
          // Allow requests from VS Code extension origin
          {
            key: "Access-Control-Allow-Origin",
            // IMPORTANT: Must be the specific origin, not '*' for credentials
            value: "vscode-file://vscode-app", 
          },
          // Allow credentials (cookies, authorization headers, etc.)
          {
            key: "Access-Control-Allow-Credentials",
            value: "true",
          },
          // Allowed methods (using the more specific set from original .js/.cjs)
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, POST, OPTIONS, HEAD",
          },
          // Allowed headers (using the specific set including X-Connection-Id, X-Request-Id)
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization, X-Connection-Id, X-Request-Id", 
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

export default nextConfig;
