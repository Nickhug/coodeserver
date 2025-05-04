import { NextRequest, NextResponse } from "next/server";
import { verifyAndConsumeAuthToken, getUser } from "../../../../lib/supabase/client";

// Define allowed origin for VVS
const ALLOWED_ORIGIN = 'vscode-file://vscode-app';

/**
 * Helper function to create a JSON response with CORS headers
 */
function createCorsResponse(body: object, status: number) {
  return NextResponse.json(body, {
    status: status,
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', // Allow POST and preflight OPTIONS
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

/**
 * API route for VVS to exchange a short-lived token for user auth details.
 */
export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();

    if (!token || typeof token !== 'string') {
      return createCorsResponse({ authenticated: false, message: "Missing or invalid token" }, 400);
    }

    // Verify the token, consume it, and get the user ID
    const { userId } = await verifyAndConsumeAuthToken(token);

    if (!userId) {
      return createCorsResponse({ authenticated: false, message: "Invalid or expired token" }, 401);
    }

    // Token is valid, get user details from DB
    const dbUser = await getUser(userId);
    if (!dbUser) {
      // This case should be rare if token generation requires user creation
      return createCorsResponse({ authenticated: false, message: "User associated with token not found" }, 404);
    }

    // Return authenticated status and user data
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
    console.error("Claim token error:", error);
    // Handle JSON parsing errors or other unexpected errors
    if (error instanceof SyntaxError) {
        return createCorsResponse({ authenticated: false, message: "Invalid JSON body" }, 400);
    }
    return createCorsResponse(
      { authenticated: false, message: "Server error during token claim" },
      500 
    );
  }
}

/**
 * Handle OPTIONS preflight requests for CORS
 */
export async function OPTIONS() {
    return createCorsResponse({}, 200);
} 