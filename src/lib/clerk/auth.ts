import { auth } from '@clerk/nextjs/server';
import { getUser } from '../supabase/client';

/**
 * Get the auth session from Clerk
 */
export async function getAuthSession() {
  return await auth();
}

/**
 * Get the current user from our database based on Clerk session
 * Assumes the user exists in our DB (created via webhook)
 */
export async function getCurrentUserWithDb() {
  const session = await auth();
  const clerkId = session?.userId;
  
  if (!clerkId) {
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