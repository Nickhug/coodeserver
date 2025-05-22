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
  
  // Add some debugging for VVS auth flow
  if (url.searchParams.has('connection_id') || url.searchParams.has('auth_token')) {
    console.log("🔄 VVS auth flow detected:", url.pathname, url.searchParams.toString());
  }

  // Always allow VVS auth token requests to pass through
  if (url.searchParams.has('auth_token')) {
    console.log("✅ Auth token request - allowing through");
    return NextResponse.next();
  }

  // Special handling for VVS connection requests
  if (url.searchParams.has('connection_id')) {
    const connectionId = url.searchParams.get('connection_id');
    console.log("🔍 Connection ID:", connectionId);
    
    // Already on the login page - allow through
    if (url.pathname.startsWith('/login')) {
      console.log("✅ Already on login page with connection_id - allowing through");
      return NextResponse.next();
    }
    
    // Already on the send-auth endpoint - allow through
    if (url.pathname.startsWith('/api/auth/send-auth')) {
      console.log("✅ On send-auth endpoint - allowing through");
      return NextResponse.next();
    }
    
    // Redirect to login with the connection_id preserved
    console.log("🔄 Redirecting to login with connection_id");
    const loginUrl = new URL('/login', req.url);
    if (connectionId) {
      loginUrl.searchParams.set('connection_id', connectionId);
    }
    return NextResponse.redirect(loginUrl);
  }

  // Standard route protection
  if (!isPublicRoute(req)) {
    // Check for Clerk session cookie instead of using the auth object directly
    const hasClerkSession = req.cookies.has('__clerk_session');
    
    if (!hasClerkSession) {
      console.log("🔒 Protected route, not authenticated - redirecting to login:", url.pathname);
      // Redirect to login
      const loginUrl = new URL('/login', req.url);
      return NextResponse.redirect(loginUrl);
    }
  }
  
  // Either public route or user is authenticated
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