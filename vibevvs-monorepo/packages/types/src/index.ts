/**
 * Export all types from the package
 */
 
export * from './ws-protocol'; 

// Additional types not in ws-protocol
export interface User {
  id: string;
  email: string;
  clerk_id: string;
  credits_remaining: number;
  subscription_tier: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthToken {
  id: string;
  token: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

 