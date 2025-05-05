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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD', // Allow all methods
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Void-Session-Token',
    },
  });
}

/**
 * API route for VVS to exchange a short-lived token for user auth details.
 */
export async function POST(req: NextRequest) {
  console.log(`[claim-token] Received token claim request`);

  try {
    // Log request headers for debugging
    console.log(`[claim-token] Request headers:`, {
      origin: req.headers.get('origin'),
      referer: req.headers.get('referer'),
      contentType: req.headers.get('content-type')
    });

    const { token } = await req.json();
    console.log(`[claim-token] Parsed token from request: ${token ? 'Present (length: ' + token.length + ')' : 'Missing'}`);

    if (!token || typeof token !== 'string') {
      console.log(`[claim-token] Invalid token format`);
      return createCorsResponse({ authenticated: false, message: "Missing or invalid token" }, 400);
    }

    // Verify the token, consume it, and get the user ID
    console.log(`[claim-token] Verifying token...`);
    const { userId } = await verifyAndConsumeAuthToken(token);
    console.log(`[claim-token] Token verification result - userId: ${userId || 'null'}`);

    if (!userId) {
      console.log(`[claim-token] Token invalid or expired`);
      return createCorsResponse({ authenticated: false, message: "Invalid or expired token" }, 401);
    }

    // Token is valid, get user details from DB
    console.log(`[claim-token] Getting user data for userId: ${userId}`);
    const dbUser = await getUser(userId);

    if (!dbUser) {
      console.log(`[claim-token] User not found in database: ${userId}`);
      // This case should be rare if token generation requires user creation
      return createCorsResponse({ authenticated: false, message: "User associated with token not found" }, 404);
    }

    console.log(`[claim-token] Successfully retrieved user: ${dbUser.id} (${dbUser.email})`);

    // Return authenticated status, user data, and session token
    return createCorsResponse({
        authenticated: true,
        user: {
            id: dbUser.id,
            email: dbUser.email,
            credits: dbUser.credits_remaining,
            subscription: dbUser.subscription_tier
        },
        sessionToken: token // Return the token as a session token
    }, 200);

  } catch (error) {
    console.error("[claim-token] Error:", error);

    // Handle JSON parsing errors or other unexpected errors
    if (error instanceof SyntaxError) {
        console.log("[claim-token] JSON parsing error");
        return createCorsResponse({ authenticated: false, message: "Invalid JSON body" }, 400);
    }

    // Log detailed error information
    if (error instanceof Error) {
      console.error("[claim-token] Detailed error:", {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    } else {
      console.error("[claim-token] Detailed error (non-Error object):", error);
    }

    return createCorsResponse(
      {
        authenticated: false,
        message: "Server error during token claim",
        error: error instanceof Error ? error.message : String(error)
      },
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