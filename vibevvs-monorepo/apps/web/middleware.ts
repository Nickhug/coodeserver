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

  // Special handling for VVS auth flow
  if (url.searchParams.has('auth_token')) {
    // This is a direct auth token request, let it pass through
    return NextResponse.next();
  }

  // Check if we're dealing with a VVS connection request
  if (url.searchParams.has('connection_id')) {
    const connectionId = url.searchParams.get('connection_id');
    
    // If not on login page, redirect to login with connection_id
    if (!url.pathname.startsWith('/login')) {
      const loginUrl = new URL('/login', req.url);
      // Make sure connectionId is not null before setting it
      if (connectionId) {
        loginUrl.searchParams.set('connection_id', connectionId);
      }
      return NextResponse.redirect(loginUrl);
    }
    
    // Already on login page with connection_id, let it proceed
    return NextResponse.next();
  }

  // Standard route protection
  if (!isPublicRoute(req)) {
    // Check if we have a session cookie that indicates authentication
    const hasSession = req.cookies.has('__clerk_session');
    
    if (!hasSession) {
      // Not authenticated, redirect to login
      const loginUrl = new URL('/login', req.url);
      // Preserve the return URL for post-login redirect
      loginUrl.searchParams.set('redirect_url', url.pathname);
      return NextResponse.redirect(loginUrl);
    }
  }
  
  // Either the route is public, or the user is authenticated
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