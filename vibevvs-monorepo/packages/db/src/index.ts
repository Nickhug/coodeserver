import { createClient } from '@supabase/supabase-js';
import logger from '@repo/logger';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Initialize Supabase client
const supabase = createClient(supabaseUrl, supabaseKey);

// User interface
export interface User {
  id: string;
  email: string;
  clerk_id: string;
  credits_remaining: number;
  subscription_tier: string | null;
  created_at: string;
  updated_at: string;
}

// Auth token interface
export interface AuthToken {
  id: string;
  token: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

/**
 * Get a user by their Clerk ID
 */
export async function getUserByClerkId(clerkId: string): Promise<User | null> {
  try {
    if (!clerkId) {
      logger.warn('No Clerk ID provided to getUserByClerkId');
      return null;
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('clerk_id', clerkId)
      .single();

    if (error) {
      logger.error('Error fetching user by Clerk ID:', error);
      return null;
    }

    return data as User;
  } catch (error) {
    logger.error('Error in getUserByClerkId:', error);
    return null;
  }
}

/**
 * Create a new user
 */
export async function createUser(clerkId: string, email: string): Promise<User | null> {
  try {
    if (!clerkId || !email) {
      logger.warn('Missing required fields for user creation');
      return null;
    }

    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          clerk_id: clerkId,
          email: email,
          credits_remaining: 100, // Default starting credits
          subscription_tier: 'free'
        }
      ])
      .select()
      .single();

    if (error) {
      logger.error('Error creating user:', error);
      return null;
    }

    logger.info(`Created new user with Clerk ID: ${clerkId}`);
    return data as User;
  } catch (error) {
    logger.error('Error in createUser:', error);
    return null;
  }
}

/**
 * Store an authentication token for a user
 */
export async function storeAuthToken(token: string, clerkId: string, expiresAt: Date): Promise<boolean> {
  try {
    logger.info(`Storing token for Clerk user ${clerkId}, expires at ${expiresAt.toISOString()}`);
    
    // First, get the user's UUID from their clerk_id
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('clerk_id', clerkId)
      .single();
    
    if (userError || !userData) {
      logger.error('[storeAuthToken] Error finding user by clerk_id:', userError || 'User not found');
      return false;
    }
    
    const userId = userData.id;
    logger.info(`Found user UUID ${userId} for clerk_id ${clerkId}`);
    
    // Insert the token into the auth_tokens table
    const { error: insertError } = await supabase
      .from('auth_tokens')
      .insert([
        {
          token,
          user_id: userId,
          expires_at: expiresAt.toISOString()
        }
      ]);
    
    if (insertError) {
      logger.error('[storeAuthToken] Error storing token:', insertError);
      return false;
    }
    
    return true;
  } catch (error) {
    logger.error('[storeAuthToken] Unexpected error:', error);
    return false;
  }
}

// NEW TYPE DEFINITIONS FOR AUTH TOKEN VERIFICATION
export type AuthTokenVerificationSuccess = { userId: string };
export type AuthTokenVerificationError = {
  errorCode: 'TOKEN_NOT_FOUND' | 'TOKEN_EXPIRED' | 'USER_NOT_FOUND' | 'DATABASE_ERROR';
  errorMessage: string;
  details?: any; // For additional error details if needed, like the raw DB error message
};
export type AuthTokenVerificationResult = AuthTokenVerificationSuccess | AuthTokenVerificationError;

/**
 * Verify and consume an authentication token.
 * Returns a result object indicating success (with userId) or failure (with error code and message).
 */
export async function verifyAndConsumeAuthToken(token: string): Promise<AuthTokenVerificationResult> {
  try {
    // Find the token in the database
    const { data: tokenData, error: tokenError } = await supabase
      .from('auth_tokens')
      .select('*')
      .eq('token', token)
      .single();

    if (tokenError || !tokenData) {
      const msg = 'Token not found in database.';
      logger.error(`[verifyAndConsumeAuthToken] ${msg}`, { tokenPrefix: token ? token.substring(0, 8) + '...' : 'undefined/empty', dbError: tokenError?.message });
      return { errorCode: 'TOKEN_NOT_FOUND', errorMessage: msg, details: tokenError?.message };
    }

    const tokenObj = tokenData as AuthToken; // AuthToken interface should be defined elsewhere in this file

    // Check if token is expired
    const expiresAt = new Date(tokenObj.expires_at);
    if (expiresAt < new Date()) {
      const msg = `Token expired at ${expiresAt.toISOString()}`;
      logger.warn(`[verifyAndConsumeAuthToken] ${msg}`, { tokenId: tokenObj.id });

      // Attempt to clean up expired token
      try {
        const { error: deleteError } = await supabase
          .from('auth_tokens')
          .delete()
          .eq('id', tokenObj.id);
        if (deleteError) {
          logger.error(`[verifyAndConsumeAuthToken] Failed to delete expired token ${tokenObj.id}`, { dbError: deleteError.message });
        } else {
          logger.info(`[verifyAndConsumeAuthToken] Deleted expired token ${tokenObj.id}`);
        }
      } catch (deleteCatchError) {
        // Log and continue, as failure to delete shouldn't prevent returning TOKEN_EXPIRED
        logger.error(`[verifyAndConsumeAuthToken] Exception during deletion of expired token ${tokenObj.id}`, deleteCatchError);
      }
      return { errorCode: 'TOKEN_EXPIRED', errorMessage: msg };
    }

    // Get the clerk_id from the user_id associated with the token
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('clerk_id')
      .eq('id', tokenObj.user_id)
      .single();

    if (userError || !userData || !userData.clerk_id) {
      const msg = 'User not found or clerk_id missing for the user associated with the token.';
      logger.error(`[verifyAndConsumeAuthToken] ${msg}`, { tokenId: tokenObj.id, userId: tokenObj.user_id, dbError: userError?.message });
      return { errorCode: 'USER_NOT_FOUND', errorMessage: msg, details: userError?.message };
    }

    // Token is valid, not expired, and user found
    logger.info(`[verifyAndConsumeAuthToken] Token verified successfully for user (clerk_id): ${userData.clerk_id}`);
    return { userId: userData.clerk_id }; // This is AuthTokenVerificationSuccess

  } catch (error) {
    const msg = 'An unexpected error occurred during token verification.';
    const errDetails = error instanceof Error ? error.message : String(error);
    logger.error(`[verifyAndConsumeAuthToken] ${msg}`, { error: errDetails, tokenPrefix: token ? token.substring(0, 8) + '...' : 'undefined/empty' });
    return { errorCode: 'DATABASE_ERROR', errorMessage: msg, details: errDetails };
  }
}

/**
 * Log API usage
 */
export async function logUsage(userId: string, provider: string, model: string, tokensUsed: number): Promise<boolean> {
  try {
    // Insert usage record
    const { error } = await supabase
      .from('usage_logs')
      .insert([
        {
          user_id: userId,
          provider,
          model,
          tokens_used: tokensUsed
        }
      ]);

    if (error) {
      logger.error('Error logging usage:', error);
      return false;
    }

    // Update user's credits
    const { error: updateError } = await supabase.rpc('deduct_credits', { 
      user_clerk_id: userId,
      amount: Math.ceil(tokensUsed / 1000) // Convert tokens to credits
    });

    if (updateError) {
      logger.error('Error updating user credits:', updateError);
      return false;
    }

    return true;
  } catch (error) {
    logger.error('Error in logUsage:', error);
    return false;
  }
}

// Export as default object
export default {
  getUserByClerkId,
  createUser,
  storeAuthToken,
  verifyAndConsumeAuthToken,
  logUsage,
};
