import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// Configure middleware to run on specific paths
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/ws).*)'],
};

export default clerkMiddleware({
  // Define public routes that don't require authentication
  publicRoutes: [
    '/',
    '/login',
    '/sign-up(.*)',
    '/api/webhooks(.*)',
    '/api/websocket',
    '/api/auth/callback',
    '/api/auth/create-connection'
  ],

  // Define routes that should be protected
  ignoredRoutes: [
    '/api/ws'
  ]
});
