import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

// Environment variables typed for safety
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Types for our database
export type User = {
  id: string;
  email: string;
  clerk_id: string;
  credits_remaining: number;
  subscription_tier: string;
  created_at: string;
  updated_at: string;
}

export type Usage = {
  id: string;
  user_id: string;
  provider: string;
  model: string;
  tokens_used: number;
  credits_used: number;
  created_at: string;
}

// --- Client Creation Functions ---

// Memoization variable for admin client
let adminClientInstance: SupabaseClient | null = null;

/**
 * Creates and returns a Supabase client with SERVICE_ROLE permissions.
 * Should only be called server-side in API routes or server actions 
 * where the service key is available and needed.
 * Uses memoization to avoid reconnecting unnecessarily.
 */
export const getSupabaseAdminClient = (): SupabaseClient => {
  if (adminClientInstance) {
    return adminClientInstance;
  }

  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    // Throw a clearer error if called without necessary env vars
    throw new Error('Supabase URL and Service Role Key are required for admin client.');
  }

  adminClientInstance = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  return adminClientInstance;
};

/**
 * Creates a Supabase client for use in client components 
 * (using anon key).
 */
export const createSupabaseBrowserClient = () => {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase URL and Anon Key are required for browser client.');
  }
  return createClient(supabaseUrl, supabaseAnonKey);
};

/**
 * Creates a Supabase client for use in server components/actions 
 * where user context might be needed (uses anon key and reads cookies).
 */
export const createServerSupabaseClient = () => {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase URL and Anon Key are required for server client.');
  }
  const cookieStore = cookies();
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        cookie: cookieStore.toString(),
      },
    },
  });
};

// --- Helper Functions using Admin Client ---
// These functions now call getSupabaseAdminClient() internally

export async function getUser(clerkId: string) {
  const supabaseAdmin = getSupabaseAdminClient();
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('clerk_id', clerkId)
    .single();

  if (error) {
    console.error('Error fetching user:', error);
    return null;
  }

  return data as User;
}

export async function createUser(clerkId: string, email: string) {
  const supabaseAdmin = getSupabaseAdminClient();
  // Default values for a new user
  const newUser = {
    clerk_id: clerkId,
    email,
    credits_remaining: 100, // Starting credits
    subscription_tier: 'free'
  };

  const { data, error } = await supabaseAdmin
    .from('users')
    .insert([newUser])
    .select()
    .single();

  if (error) {
    console.error('Error creating user:', error);
    return null;
  }

  return data as User;
}

export async function updateUserCredits(userId: string, creditsToAdd: number) {
  const supabaseAdmin = getSupabaseAdminClient();
  // Placeholder for the actual RPC call logic if needed
  // For direct update:
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('credits_remaining')
    .eq('id', userId)
    .single();

  if (error || !data) {
    console.error('Error fetching current credits:', error);
    return null;
  }

  const newCredits = data.credits_remaining + creditsToAdd;

  const { data: updatedData, error: updateError } = await supabaseAdmin
    .from('users')
    .update({ credits_remaining: newCredits })
    .eq('id', userId)
    .select()
    .single();

  if (updateError) {
    console.error('Error updating user credits:', updateError);
    return null;
  }

  return updatedData as User;
}

export async function logUsage(usage: Omit<Usage, 'id' | 'created_at'>) {
  const supabaseAdmin = getSupabaseAdminClient();
  const { data, error } = await supabaseAdmin
    .from('usage')
    .insert([usage])
    .select();

  if (error) {
    console.error('Error logging usage:', error);
    return null;
  }

  return data[0] as Usage;
}

export async function getUserUsage(userId: string, startDate?: string, endDate?: string) {
  const supabaseAdmin = getSupabaseAdminClient();
  let query = supabaseAdmin
    .from('usage')
    .select('*')
    .eq('user_id', userId);
  
  if (startDate) {
    query = query.gte('created_at', startDate);
  }
  
  if (endDate) {
    query = query.lte('created_at', endDate);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching user usage:', error);
    return null;
  }

  return data as Usage[];
}

// --- Auth Token Functions using Admin Client ---

export async function storeAuthToken(token: string, userId: string, expiresAt: Date) {
  const supabaseAdmin = getSupabaseAdminClient();
  const { data, error } = await supabaseAdmin
    .from('auth_tokens')
    .insert({ token, user_id: userId, expires_at: expiresAt.toISOString() })
    .select()
    .single();
  
  if (error) {
    console.error('Error storing auth token:', error);
    return null;
  }
  return data;
}

export async function deleteExpiredAuthTokens() {
  const supabaseAdmin = getSupabaseAdminClient();
  const { error } = await supabaseAdmin
    .from('auth_tokens')
    .delete()
    .lt('expires_at', new Date().toISOString());

  if (error) {
    console.error('Error deleting expired auth tokens:', error);
  }
}

export async function verifyAndConsumeAuthToken(token: string): Promise<{ userId: string | null }> {
  const supabaseAdmin = getSupabaseAdminClient();
  const { data: tokenData, error: findError } = await supabaseAdmin
    .from('auth_tokens')
    .select('user_id, expires_at')
    .eq('token', token)
    .single();

  if (findError || !tokenData) {
    return { userId: null };
  }
  
  if (new Date(tokenData.expires_at) < new Date()) {
    // Token expired, delete it
    await supabaseAdmin.from('auth_tokens').delete().eq('token', token);
    return { userId: null };
  }

  // Token is valid and not expired, consume (delete) it
  const { error: deleteError } = await supabaseAdmin
    .from('auth_tokens')
    .delete()
    .eq('token', token);

  if (deleteError) {
    // Log the error but still return the userId as verification succeeded before deletion attempt
    console.error('Error deleting auth token after verification:', deleteError);
  }

  return { userId: tokenData.user_id };
} 