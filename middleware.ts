import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// Create a matcher for routes that should be protected
const isProtectedRoute = createRouteMatcher([
  '/api/auth/verify',
  '/api/auth/user',
  '/api/auth/send-auth',
  '/api/auth/claim-token',
  '/api/ai-providers(.*)',
  '/api/usage(.*)',
]);

// Create a matcher for routes that should bypass Clerk authentication
const isPublicRoute = createRouteMatcher([
  '/',
  '/login',
  '/sign-up(.*)',
  '/api/webhooks(.*)',
  '/api/websocket',
  '/api/auth/callback',
  '/api/auth/create-connection',
]);

export default clerkMiddleware((auth, req) => {
  // Allow WebSocket connections without authentication
  // They will be authenticated separately in the WebSocket server
  if (req.nextUrl.pathname === '/api/ws') {
    return NextResponse.next();
  }
  
  // Allow public routes without authentication
  if (isPublicRoute(req)) {
    return NextResponse.next();
  }
  
  // For protected routes, let Clerk handle authentication
  if (isProtectedRoute(req)) {
    return auth();
  }
  
  // For all other routes, proceed normally
  return NextResponse.next();
});

// Configure middleware to run on specific paths
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
