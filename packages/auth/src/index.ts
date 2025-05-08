import logger from '@repo/logger';

// Store the secret key for later use
let secretKey: string | null = null;

/**
 * Initialize Clerk client with secret key
 * @param clerkSecretKey Clerk secret key
 */
export function initClerk(clerkSecretKey: string): void {
  if (!clerkSecretKey) {
    logger.error('No Clerk secret key provided');
    return;
  }
  
  secretKey = clerkSecretKey;
  logger.info('Clerk authentication initialized');
}

/**
 * Verify a Clerk session token
 * @param token The session token to verify
 * @returns The user ID if valid, null otherwise
 */
export async function verifyToken(token: string): Promise<string | null> {
  try {
    if (!token) {
      logger.warn('Empty token provided for verification');
      return null;
    }

    // In development mode, accept any token format
    if (process.env.NODE_ENV === 'development') {
      logger.warn('Running in development mode, skipping token verification');
      
      // For tokens starting with "test_", extract a fake user ID
      if (token.startsWith('test_')) {
        const fakeUserId = token.slice(5) || 'dev_user_123';
        logger.debug(`Development mode: Using fake user ID: ${fakeUserId}`);
        return fakeUserId;
      }
      
      // Default development user
      return 'dev_user_123';
    }
    
    // In production, we should use the Clerk API to verify tokens
    // This is a simplified approach for now
    if (!secretKey) {
      logger.warn('Clerk not initialized, cannot verify token');
      return null;
    }
    
    // TODO: Implement proper validation with Clerk API
    // For now, just check if it starts with the expected prefix
    if (token.startsWith('clerk_')) {
      // Extract a user ID from the token (simplified)
      const userId = `user_${token.substring(6, 14)}`;
      logger.debug(`Token validation simplified: ${userId}`);
      return userId;
    }

    logger.warn('Invalid token format');
    return null;
  } catch (error) {
    logger.error('Token verification error:', error);
    return null;
  }
}

/**
 * Get user information from Clerk
 * @param userId The Clerk user ID
 * @returns User information if found, null otherwise
 */
export async function getUserInfo(userId: string): Promise<any | null> {
  try {
    if (!userId) {
      logger.warn('Empty userId provided for user info retrieval');
      return null;
    }
    
    // In development mode, return fake data
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Development mode: Returning fake user info');
      return {
        id: userId,
        email: `user-${userId.substring(0, 8)}@example.com`,
        firstName: 'Test',
        lastName: 'User',
        createdAt: new Date().toISOString(),
      };
    }
    
    // For production, this would call the Clerk API
    // TODO: Implement proper Clerk API integration
    
    // Basic mock implementation
    return {
      id: userId,
      email: `${userId.substring(0, 10)}@example.com`,
      firstName: 'User',
      lastName: userId.substring(0, 5),
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Error getting user info:', error);
    return null;
  }
}

/**
 * Check if a user has sufficient credits
 * @param userId The user ID
 * @param requiredCredits The number of credits required
 * @returns Whether the user has sufficient credits
 */
export async function checkUserCredits(
  userId: string,
  requiredCredits: number
): Promise<{ hasCredits: boolean; creditsRemaining: number }> {
  try {
    // TODO: Implement proper credit checking with database
    // For now, we'll return mock data
    const creditsRemaining = 1000;
    return {
      hasCredits: creditsRemaining >= requiredCredits,
      creditsRemaining,
    };
  } catch (error) {
    logger.error('Error checking user credits:', error);
    return { hasCredits: false, creditsRemaining: 0 };
  }
}

export default {
  initClerk,
  verifyToken,
  getUserInfo,
  checkUserCredits,
};
