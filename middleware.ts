import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAuth } from '@clerk/nextjs/server';

// List of public routes that don't require authentication
const publicRoutes = [
  '/',
  '/login',
  '/sign-up',
  '/api/webhooks',
  '/api/websocket',
  '/api/auth/callback',
  '/api/auth/create-connection'
];

// Configure middleware to run on specific paths
export const config = {
  matcher: [
    // Skip all static files and WebSocket path
    '/((?!_next/static|_next/image|favicon.ico|api/ws).*)',
  ],
};

// Export the middleware function
export default function middleware(req: NextRequest) {
  // Skip WebSocket connections
  if (req.nextUrl.pathname === '/api/ws') {
    return NextResponse.next();
  }

  // Check if the route is public
  const isPublicRoute = publicRoutes.some(route => {
    if (route.endsWith('(.*)')) {
      const baseRoute = route.replace('(.*)', '');
      return req.nextUrl.pathname.startsWith(baseRoute);
    }
    return req.nextUrl.pathname === route || req.nextUrl.pathname.startsWith(`${route}/`);
  });

  // Allow public routes without authentication
  if (isPublicRoute) {
    return NextResponse.next();
  }

  // For protected routes, check authentication
  const { userId } = getAuth(req);

  // If not authenticated and trying to access a protected route, redirect to login
  if (!userId) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('redirect_url', req.url);
    return NextResponse.redirect(loginUrl);
  }

  // User is authenticated, allow access
  return NextResponse.next();
}
