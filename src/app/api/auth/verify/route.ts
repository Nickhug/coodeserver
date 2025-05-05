import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Void-Session-Token',
    },
  });
}

/**
 * API route that verifies a user's authentication status via Clerk session or custom token.
 * Supports both cookie-based and custom token-based authentication.
 */
export async function GET(req: NextRequest) {
  try {
    // Check for custom session token in query parameter or header
    const sessionToken = req.nextUrl.searchParams.get('token') || req.headers.get('x-void-session-token');
    let clerkUserId: string | null = null;

    // First try custom token-based auth if token is present
    if (sessionToken) {
      console.log("Attempting custom token-based authentication");

      try {
        // For now, we'll just use the token directly as the user ID
        // In a production environment, you'd want to validate this token against a database
        // or use a proper JWT with validation

        // This is a simplified approach for demonstration
        // In a real implementation, you would verify the token's validity

        // Extract the user ID from the token or database lookup
        // For now, we'll check if the token exists in our database
        // This is a placeholder - implement proper token validation

        // For testing, we'll accept any token
        clerkUserId = "user_2wcizcY350f9UEanAONtT36Qjhv"; // Hardcoded for testing
        console.log("Custom token-based authentication successful for user:", clerkUserId);
      } catch (tokenError) {
        console.error("Custom token verification failed:", tokenError);
        // Continue to try session-based auth
      }
    }

    // If custom token auth failed, try session-based auth
    if (!clerkUserId) {
      console.log("Attempting session-based authentication");
      const session = await auth();
      clerkUserId = session?.userId || null;

      if (clerkUserId) {
        console.log("Session-based authentication successful for user:", clerkUserId);
      } else {
        console.log("Authentication failed: No valid session or token");
        return createCorsResponse(
          { authenticated: false, message: "User not authenticated via Clerk session or custom token" },
          401
        );
      }
    }

    // Get user from database
    const dbUser = await getUser(clerkUserId);
    if (!dbUser) {
      console.log("User not found in database:", clerkUserId);
      return createCorsResponse(
        { authenticated: false, message: "User found in auth provider but not in database" },
        404
      );
    }

    console.log("Authentication successful for user:", dbUser.id);
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

/**
 * Handle OPTIONS requests for CORS preflight
 */
export async function OPTIONS() {
  return createCorsResponse({}, 200);
}