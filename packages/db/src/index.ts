import { createClient, SupabaseClient } from '@supabase/supabase-js';
import logger from '@repo/logger';

// Types for our database
export type User = {
  id: string;
  email: string;
  clerk_id: string;
  credits_remaining: number;
  subscription_tier: string;
  created_at: string;
  updated_at: string;
};

export type Usage = {
  id: string;
  user_id: string;
  provider: string;
  model: string;
  tokens_used: number;
  credits_used: number;
  created_at: string;
};

// Memoization variable for admin client
let adminClientInstance: SupabaseClient | null = null;

/**
 * Creates and returns a Supabase client with SERVICE_ROLE permissions.
 * Should only be called server-side where the service key is available.
 * Uses memoization to avoid reconnecting unnecessarily.
 */
export const getSupabaseAdminClient = (): SupabaseClient => {
  if (adminClientInstance) {
    return adminClientInstance;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase URL and Service Role Key are required for admin client.');
  }

  adminClientInstance = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return adminClientInstance;
};

/**
 * Get a user by their Clerk ID
 */
export async function getUserByClerkId(clerkId: string): Promise<User | null> {
  try {
    const supabase = getSupabaseAdminClient();
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
 * Update a user's credits
 */
export async function updateUserCredits(
  userId: string,
  creditsUsed: number
): Promise<boolean> {
  try {
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.rpc('update_user_credits', {
      p_user_id: userId,
      p_credits_used: creditsUsed,
    });

    if (error) {
      logger.error('Error updating user credits:', error);
      return false;
    }

    return true;
  } catch (error) {
    logger.error('Error in updateUserCredits:', error);
    return false;
  }
}

/**
 * Log usage of AI providers
 */
export async function logUsage(
  userId: string,
  provider: string,
  model: string,
  tokensUsed: number,
  creditsUsed: number
): Promise<boolean> {
  try {
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from('usage').insert([{
      user_id: userId,
      provider,
      model,
      tokens_used: tokensUsed,
      credits_used: creditsUsed
    }]);

    if (error) {
      logger.error('Error logging usage:', error);
      return false;
    }

    return true;
  } catch (error) {
    logger.error('Error in logUsage:', error);
    return false;
  }
}

/**
 * Get remaining credits for a user
 * @param userId User ID
 * @returns Number of credits remaining
 */
export async function getRemainingCredits(userId: string): Promise<number> {
  try {
    // In a real implementation, this would query the database for the user's remaining credits
    // For now, we just return a default value
    logger.info(`Getting remaining credits for user: ${userId}`);
    
    // TODO: Implement actual database query once Supabase is set up
    return 1000; // Default value
  } catch (error) {
    logger.error('Error getting remaining credits:', error);
    return 0;
  }
}

/**
 * Deduct credits from a user's account
 * @param userId User ID
 * @param creditsToDeduct Number of credits to deduct
 * @returns Whether the deduction was successful
 */
export async function deductCredits(
  userId: string,
  creditsToDeduct: number
): Promise<boolean> {
  try {
    // In a real implementation, this would update the database
    // For now, we just log it
    logger.info(`Deducting ${creditsToDeduct} credits from user: ${userId}`);
    
    // TODO: Implement actual database update once Supabase is set up
    return true;
  } catch (error) {
    logger.error('Error deducting credits:', error);
    return false;
  }
}

export default {
  getSupabaseAdminClient,
  getUserByClerkId,
  updateUserCredits,
  logUsage,
  getRemainingCredits,
  deductCredits,
};
