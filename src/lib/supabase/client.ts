import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

// Environment variables typed for safety
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

// Client used on the client-side (limited permissions)
export const createSupabaseClient = () => {
  return createClient(supabaseUrl, supabaseAnonKey);
};

// Admin client with service role (server-side only)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Client for server components
export const createServerSupabaseClient = () => {
  const cookieStore = cookies();
  
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        cookie: cookieStore.toString(),
      },
    },
  });
};

// Helper functions for common database operations
export async function getUser(clerkId: string) {
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
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ 
      credits_remaining: supabaseAdmin.rpc('increment_credits', { 
        user_id: userId,
        amount: creditsToAdd 
      })
    })
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    console.error('Error updating user credits:', error);
    return null;
  }

  return data as User;
}

export async function logUsage(usage: Omit<Usage, 'id' | 'created_at'>) {
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