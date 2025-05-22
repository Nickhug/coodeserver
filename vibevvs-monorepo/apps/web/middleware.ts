import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';

// Define your public routes using a matcher
// These routes will not be protected by default by auth().protect()
const isPublicRoute = createRouteMatcher([
  '/', // Landing page
  '/login(.*)', // Login and its sub-paths (e.g., for Clerk's multi-step flows)
  '/sign-up(.*)', // Sign-up and its sub-paths
  // VVS specific API routes & other public APIs
  '/api/auth/send-auth',
  '/api/auth/callback',
  '/api/ws-auth',
  '/api/proxy',
  // Add any other public frontend routes or API endpoints here
]);

export default clerkMiddleware((auth, req) => {
  const url = new URL(req.url);

  // 1. Prioritize VVS auth token flow: If these params are present, let it through immediately.
  // This allows VVS to handle its authentication without Clerk interfering.
  if (url.searchParams.has('auth_token') || url.searchParams.has('connection_id')) {
    return NextResponse.next();
  }

  // 2. If the route is NOT a public route (as defined by our matcher),
  // then protect it. auth() itself gives access to userId, protect(), etc.
  if (!isPublicRoute(req)) {
    auth.protect();
  }
  
  // 3. If it is a public route (or if auth().protect() didn't redirect because user is authenticated),
  // allow the request to proceed.
  return NextResponse.next();
});

export const config = {
  matcher: [
    // Match all routes except static files and _next internal files
    '/((?!.*\\..*|_next).*)', 
    '/', // Ensure root is matched
    '/(api|trpc)(.*)', // Match API routes
  ],
}; 