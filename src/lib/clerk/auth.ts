import { auth } from '@clerk/nextjs/server';
import { getUser } from '../supabase/client';
import { verifyToken } from '@clerk/backend';
import { NextRequest } from 'next/server';

/**
 * Get the auth session from Clerk
 */
export async function getAuthSession() {
  return await auth();
}

/**
 * Get the current user from our database based on Clerk session or token
 * Supports both cookie-based and token-based authentication
 */
export async function getCurrentUserWithDb(req?: NextRequest) {
  let clerkId: string | null = null;

  // First try token-based auth if request is provided and has Authorization header
  if (req) {
    const authHeader = req.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7); // Remove 'Bearer ' prefix
      console.log("Attempting token-based authentication");

      try {
        // Verify the token using Clerk's Backend SDK
        const claims = await verifyToken(token, {
          secretKey: process.env.CLERK_SECRET_KEY,
        });

        // Extract user ID from the verified token
        clerkId = claims.sub;
        console.log("Token-based authentication successful for user:", clerkId);
      } catch (tokenError) {
        console.error("Token verification failed:", tokenError);
        // Continue to try session-based auth
      }
    }
  }

  // If token auth failed or no request provided, try session-based auth
  if (!clerkId) {
    console.log("Attempting session-based authentication");
    const session = await auth();
    clerkId = session?.userId || null;

    if (clerkId) {
      console.log("Session-based authentication successful for user:", clerkId);
    }
  }

  // If both auth methods failed, return null
  if (!clerkId) {
    console.log("Authentication failed: No valid session or token");
    return null;
  }

  try {
    // Try to get existing user from our database
    const dbUser = await getUser(clerkId);

    if (!dbUser) {
      // User should have been created by the webhook
      // Log an error or handle appropriately
      console.warn(`User with clerkId ${clerkId} not found in database.`);
      return null;
    }

    // We don't fetch the full Clerk user object here anymore
    // We rely on our database record
    return {
      dbUser,
    };
  } catch (error) {
    console.error('Error getting user data:', error);
    return null;
  }
}

/**
 * Check if the current user has credits available
 */
export async function checkUserCredits(requiredCredits: number = 1) {
  const userInfo = await getCurrentUserWithDb();

  if (!userInfo || !userInfo.dbUser) {
    return {
      hasCredits: false,
      creditsRemaining: 0,
    };
  }

  return {
    hasCredits: userInfo.dbUser.credits_remaining >= requiredCredits,
    creditsRemaining: userInfo.dbUser.credits_remaining,
  };
}

/**
 * Helper to check if the user is authenticated
 * For use in middleware or server actions
 */
export async function requireAuth() {
  const session = await auth();

  if (!session?.userId) {
    throw new Error('Authentication required');
  }

  return session;
}