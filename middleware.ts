import { clerkMiddleware, authMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// List of public routes that don't require authentication
const publicRoutes = [
  '/',
  '/login',
  '/sign-up(.*)',
  '/api/webhooks(.*)',
  '/api/websocket',
  '/api/auth/callback',
  '/api/auth/create-connection'
];

// Configure middleware to run on specific paths
export const config = {
  matcher: [
    // Skip all static files
    '/((?!_next/static|_next/image|favicon.ico|api/ws).*)',
  ],
};

// Export the middleware function
export default authMiddleware({
  publicRoutes: publicRoutes,
  ignoredRoutes: ['/api/ws']
});
