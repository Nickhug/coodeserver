import { clerkMiddleware } from '@clerk/nextjs/server';

// Configure middleware to run on specific paths
export const config = {
  matcher: [
    // Skip all static files and WebSocket path
    '/((?!_next/static|_next/image|favicon.ico|api/ws).*)',
  ],
};

// Export the middleware function
export default clerkMiddleware();
