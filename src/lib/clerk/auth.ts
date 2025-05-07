import { auth } from '@clerk/nextjs/server';
import { getUser } from '../supabase/client';
import { NextRequest } from 'next/server';

/**
 * Get the auth session from Clerk
 */
export async function getAuthSession() {
  return await auth();
}

/**
 * Get the current user from our database based on Clerk session or custom token
 * Supports both cookie-based and custom token-based authentication
 */
export async function getCurrentUserWithDb(req?: NextRequest) {
  let clerkId: string | null = null;

  // First try custom token-based auth if request is provided and has the token
  if (req) {
    const sessionToken = req.nextUrl.searchParams.get('token') || req.headers.get('x-void-session-token');
    if (sessionToken) {
      console.log("Attempting custom token-based authentication");

      try {
        // For now, we'll accept any token from Void and use a hardcoded user ID
        // In production, you would verify the token against your database
        if (sessionToken) {
          // This is a temporary solution - in production, validate the token properly
          clerkId = "user_2wcizcY350f9UEanAONtT36Qjhv"; // Hardcoded for testing
          console.log("Custom token-based authentication successful for user:", clerkId);
        }
      } catch (tokenError) {
        console.error("Custom token verification failed:", tokenError);
        // Continue to try session-based auth
      }
    }
  }

  // If custom token auth failed or no request provided, try session-based auth
  if (!clerkId) {
    console.log("Attempting session-based authentication");
    const session = await auth();
    clerkId = session?.userId || null;

    if (clerkId) {
      console.log("Session-based authentication successful for user:", clerkId);
    } else {
      console.log("Authentication failed: No valid session or token");
      return null;
    }
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
export async function checkUserCredits(requiredCredits: number = 1, req?: NextRequest) {
  const userInfo = await getCurrentUserWithDb(req);

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
 * Check if a user has credits available, looking up user by ID
 */
export async function checkUserCreditsById(userId: string, requiredCredits: number = 1) {
  if (!userId) {
    console.warn('[checkUserCreditsById] userId not provided.');
    return {
      hasCredits: false,
      creditsRemaining: 0,
    };
  }
  try {
    const dbUser = await getUser(userId); // getUser is from ../supabase/client
    if (!dbUser) {
      console.warn(`[checkUserCreditsById] User with id ${userId} not found in database.`);
      return {
        hasCredits: false,
        creditsRemaining: 0,
      };
    }
    return {
      hasCredits: dbUser.credits_remaining >= requiredCredits,
      creditsRemaining: dbUser.credits_remaining,
    };
  } catch (error) {
    console.error(`[checkUserCreditsById] Error checking credits for user ${userId}:`, error);
    return {
      hasCredits: false,
      creditsRemaining: 0,
    };
  }
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