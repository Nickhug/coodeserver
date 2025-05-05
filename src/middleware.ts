import { clerkMiddleware } from '@clerk/nextjs/server';

// Configure middleware to run on specific paths
export const config = {
  matcher: [
    // Include all API routes except WebSocket
    '/api/((?!ws).*)',
    // Explicitly include auth routes to ensure they're processed by Clerk middleware
    '/api/auth/:path*',
    // Include all other routes except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};

// Export the middleware function
export default clerkMiddleware();
