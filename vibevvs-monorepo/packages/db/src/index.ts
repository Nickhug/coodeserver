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

/**
 * Verify and consume an authentication token
 */
export async function verifyAndConsumeAuthToken(token: string): Promise<{ userId: string } | null> {
  try {
    // Find the token in the database
    const { data: tokenData, error: tokenError } = await supabase
      .from('auth_tokens')
      .select('*')
      .eq('token', token)
      .single();
    
    if (tokenError || !tokenData) {
      logger.error('[verifyAndConsumeAuthToken] Token not found or error:', tokenError);
      return null;
    }
    
    const tokenObj = tokenData as AuthToken;
    
    // Check if token is expired
    const expiresAt = new Date(tokenObj.expires_at);
    if (expiresAt < new Date()) {
      logger.warn('[verifyAndConsumeAuthToken] Token expired at', expiresAt);
      
      // Clean up expired token
      await supabase
        .from('auth_tokens')
        .delete()
        .eq('id', tokenObj.id);
      
      return null;
    }
    
    // Get the clerk_id from the user_id
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('clerk_id')
      .eq('id', tokenObj.user_id)
      .single();
    
    if (userError || !userData) {
      logger.error('[verifyAndConsumeAuthToken] User not found:', userError);
      return null;
    }
    
    const clerkId = userData.clerk_id;
    logger.info(`[verifyAndConsumeAuthToken] Token found for clerk user: ${clerkId}`);
    
    // Delete the token to prevent reuse (one-time use)
    await supabase
      .from('auth_tokens')
      .delete()
      .eq('id', tokenObj.id);
    
    return { userId: clerkId };
  } catch (error) {
    logger.error('[verifyAndConsumeAuthToken] Unexpected error:', error);
    return null;
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
