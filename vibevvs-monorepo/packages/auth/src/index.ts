import { createClerkClient } from '@clerk/backend';
import logger from '@repo/logger';
import { getUserByClerkId, storeAuthToken as dbStoreAuthToken } from '@repo/db';
import type { User } from '@repo/types';

// Store the clerk client for later use
let clerkClient: ReturnType<typeof createClerkClient> | null = null;
let jwtKey: string | null = null;

/**
 * Initialize Clerk client with secret key and optional JWT key
 * @param clerkSecretKey Clerk secret key
 * @param clerkJwtKey Optional JWT key for networkless verification
 * @param clerkPublishableKey Optional publishable key
 */
export function initClerk(clerkSecretKey: string, clerkJwtKey?: string, clerkPublishableKey?: string): void {
  if (!clerkSecretKey) {
    logger.error('No Clerk secret key provided');
    return;
  }
  
  try {
    clerkClient = createClerkClient({
      secretKey: clerkSecretKey,
      publishableKey: clerkPublishableKey,
      // Store JWT key for networkless verification if provided
      ...(clerkJwtKey ? { jwtKey: clerkJwtKey } : {})
    });
    
    if (clerkJwtKey) {
      jwtKey = clerkJwtKey;
      logger.info('Clerk authentication initialized with JWT key (networkless mode)');
    } else {
      logger.info('Clerk authentication initialized');
    }
  } catch (error) {
    logger.error('Failed to initialize Clerk client:', error);
  }
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
    
    // In production, use the Clerk SDK to verify tokens
    if (!clerkClient) {
      logger.warn('Clerk not initialized, cannot verify token');
      return null;
    }

    try {
      // Create a mock request object with the token in the Authorization header
      // This is needed because authenticateRequest expects a Request object
      const mockRequest = new Request('https://dummy-url', {
        headers: {
          // Format it as a Bearer token which is what Clerk expects
          Authorization: `Bearer ${token}`
        }
      });
      
      // Use authenticateRequest to verify the token
      const authResult = await clerkClient.authenticateRequest(mockRequest, {
        // If we have a JWT key, use it for networkless verification
        ...(jwtKey ? { jwtKey } : {}),
        // Add any additional domains that are authorized to use this token
        authorizedParties: ['https://coode.ai', 'http://localhost']
      });
      
      if (authResult.isSignedIn && authResult.toAuth().userId) {
        const userId = authResult.toAuth().userId;
        logger.debug(`Token verified for user: ${userId}`);
        return userId;
      } else {
        logger.warn('Token verification failed: User not signed in or userId missing');
        return null;
      }
    } catch (verifyError) {
      logger.error('Token verification error:', verifyError);
      return null;
    }

    logger.warn('Invalid token format or verification failed');
    return null;
  } catch (error) {
    logger.error('Token verification error:', error);
    return null;
  }
}

/**
 * Get user information from database by Clerk ID
 * @param clerkId The Clerk user ID
 * @returns User information if found, null otherwise
 */
export async function getDbUserByClerkId(clerkId: string): Promise<User | null> {
  try {
    if (!clerkId) {
      logger.warn('Empty clerkId provided');
      return null;
    }
    
    // Get user from database
    const user = await getUserByClerkId(clerkId);
    
    if (!user) {
      logger.warn(`User with Clerk ID ${clerkId} not found in database`);
      return null;
    }
    
    return user;
  } catch (error) {
    logger.error('Error getting user from database:', error);
    return null;
  }
}

/**
 * Store an authentication token in the database
 * @param token The token to store
 * @param clerkId The Clerk ID of the user
 * @param expiresAt When the token expires
 * @returns Success status
 */
export async function storeAuthToken(token: string, clerkId: string, expiresAt: Date): Promise<boolean> {
  try {
    logger.info(`Storing auth token for Clerk user ${clerkId}, expires at ${expiresAt.toISOString()}`);
    
    if (!token || !clerkId) {
      logger.error('Missing token or Clerk ID for token storage');
      return false;
    }
    
    const result = await dbStoreAuthToken(token, clerkId, expiresAt);
    
    if (!result) {
      logger.error('Failed to store token in database');
      return false;
    }
    
    logger.info(`Successfully stored auth token for user ${clerkId}`);
    return true;
  } catch (error) {
    logger.error(`Error storing auth token for user ${clerkId}:`, error);
    return false;
  }
}

/**
 * Generate a secure random token for authentication
 * @returns A random token string
 */
export function generateToken(): string {
  return Array.from(
    { length: 32 },
    () => Math.floor(Math.random() * 36).toString(36)
  ).join('');
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
    const user = await getDbUserByClerkId(userId);
    
    if (!user) {
      logger.warn(`User with ID ${userId} not found when checking credits`);
      return { hasCredits: false, creditsRemaining: 0 };
    }
    
    const creditsRemaining = user.credits_remaining || 0;
    return {
      hasCredits: creditsRemaining >= requiredCredits,
      creditsRemaining,
    };
  } catch (error) {
    logger.error('Error checking user credits:', error);
    return { hasCredits: false, creditsRemaining: 0 };
  }
}

/**
 * Get rich user information directly from Clerk
 * @param clerkId The Clerk user ID
 * @returns Enhanced user information if found, null otherwise
 */
export async function getClerkUserData(clerkId: string): Promise<any | null> {
  try {
    if (!clerkId) {
      logger.warn('Empty clerkId provided');
      return null;
    }
    
    if (!clerkClient) {
      logger.warn('Clerk not initialized, cannot fetch user data');
      return null;
    }
    
    // Get user from Clerk
    const clerkUser = await clerkClient.users.getUser(clerkId);
    
    if (!clerkUser) {
      logger.warn(`User with Clerk ID ${clerkId} not found in Clerk`);
      return null;
    }
    
    // Get primary avatar URL and other user data
    return {
      id: clerkId,
      firstName: clerkUser.firstName,
      lastName: clerkUser.lastName,
      name: clerkUser.firstName && clerkUser.lastName ? 
        `${clerkUser.firstName} ${clerkUser.lastName}` : 
        clerkUser.username || clerkUser.emailAddresses[0]?.emailAddress?.split('@')[0] || '',
      email: clerkUser.emailAddresses[0]?.emailAddress || '',
      avatarUrl: clerkUser.imageUrl,
      username: clerkUser.username
    };
  } catch (error) {
    logger.error('Error getting user from Clerk:', error);
    return null;
  }
}

export default {
  initClerk,
  verifyToken,
  getDbUserByClerkId,
  getClerkUserData,
  storeAuthToken,
  generateToken,
  checkUserCredits,
};
