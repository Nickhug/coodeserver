import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getUser } from "../../../../lib/supabase/client";

// Define allowed origin for VVS
const ALLOWED_ORIGIN = 'vscode-file://vscode-app';

/**
 * Helper function to create a JSON response with CORS headers
 * Note: This might become less relevant if verify is only used by browser
 */
function createCorsResponse(body: object, status: number) {
  // If needed, add logic here to only add CORS for specific requests 
  // or remove if verify is truly browser-only via Clerk session.
  return NextResponse.json(body, {
    status: status,
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN, // Keep for now 
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

/**
 * API route that verifies a user's authentication status via Clerk session.
 * Primarily for browser contexts or requests where Clerk session is available.
 */
export async function GET(/* Removed req: NextRequest */) { 
  // Removed OPTIONS check as headers config handles it
  
  try {
    // Check Clerk session 
    const session = await auth();
    const clerkUserId = session?.userId;

    if (!clerkUserId) {
        return createCorsResponse(
          { authenticated: false, message: "User not authenticated via Clerk session" },
          401 
        );
    }
    
    const dbUser = await getUser(clerkUserId);
    if (!dbUser) {
        return createCorsResponse(
          { authenticated: false, message: "User found in auth provider but not in database" },
          404 
        );
    }

    return createCorsResponse({ 
        authenticated: true,
        user: {
        id: dbUser.id,
        email: dbUser.email,
        credits: dbUser.credits_remaining,
        subscription: dbUser.subscription_tier
        }
    }, 200);

  } catch (error) {
    console.error("Verify auth error:", error);
    return createCorsResponse(
      { authenticated: false, message: "Server error during authentication verification" },
      500 
    );
  }
} 