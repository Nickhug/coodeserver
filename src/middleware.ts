import { NextRequest, NextResponse } from 'next/server';

// This middleware provides basic auth protection for our routes
export default function middleware(req: NextRequest) {
  // Get the pathname from the URL
  const path = req.nextUrl.pathname;
  
  // Public routes that don't require authentication
  const isPublicRoute = 
    path === '/' || 
    path === '/login' ||
    path.startsWith('/api/webhooks/') ||
    path.startsWith('/_next/') ||
    path.includes('.'); // Static files
    
  // Check if user is authenticated via our vvs_auth cookie
  const isAuthenticated = req.cookies.has('vvs_auth');
  
  // If not a public route and not authenticated, redirect to login
  if (!isPublicRoute && !isAuthenticated) {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!.+\\.[\\w]+$|_next).*)', '/', '/(api|trpc)(.*)'],
}; 