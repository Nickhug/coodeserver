import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "../../../../lib/supabase/client";

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
      'Access-Control-Allow-Methods': 'GET, OPTIONS', // Allow GET and preflight OPTIONS
      'Access-Control-Allow-Headers': 'Content-Type', // Allow common headers
    },
  });
}

/**
 * API route that verifies a user's authentication status
 * Can verify based on Clerk session OR the vvs_auth cookie set during callback.
 */
export async function GET(req: NextRequest) {
  // Handle preflight OPTIONS requests for CORS
  if (req.method === 'OPTIONS') {
    return createCorsResponse({}, 200);
  }
  
  try {
    // 1. Check Clerk session first
    const session = await auth();
    const clerkUserId = session?.userId;

    if (clerkUserId) {
      const dbUser = await getUser(clerkUserId);
      if (dbUser) {
        return createCorsResponse({
          authenticated: true,
          user: {
            id: dbUser.id,
            email: dbUser.email,
            credits: dbUser.credits_remaining,
            subscription: dbUser.subscription_tier
          }
        }, 200);
      } else {
         // Clerk user exists but not in our DB (should ideally not happen after callback)
        return createCorsResponse(
          { authenticated: false, message: "User found in auth provider but not in database" },
          404 
        );
      }
    }

    // 2. If no Clerk session, check for vvs_auth cookie (for VVS polling) via req
    const vvsAuthCookie = req.cookies.get('vvs_auth');

    if (vvsAuthCookie) {
      try {
        const cookieData = JSON.parse(vvsAuthCookie.value);
        const { userId, email, credits, subscription } = cookieData;

        if (userId && email) {
          // Optional: Add a quick check if user exists in DB
          const dbCheck = await getUser(userId);
          if (!dbCheck) {
            return createCorsResponse(
              { authenticated: false, message: "User from cookie not found in database" },
              404 
            );
          }
          // If user exists, trust cookie data set by our callback
          return createCorsResponse({
            authenticated: true,
            user: { id: userId, email, credits, subscription }
          }, 200);
        } else {
           return createCorsResponse(
            { authenticated: false, message: "Invalid data in vvs_auth cookie" },
            400 
          );
        }
      } catch (parseError) {
         console.error("Failed to parse vvs_auth cookie:", parseError);
         return createCorsResponse(
          { authenticated: false, message: `Failed to parse vvs_auth cookie: ${(parseError as Error).message}` },
          400 
        );
      }
    }

    // 3. If neither method works, user is not authenticated
    return createCorsResponse(
      { authenticated: false, message: "User not authenticated" },
      401 
    );

  } catch (error) {
    console.error("Verify auth error:", error);
    return createCorsResponse(
      { authenticated: false, message: "Server error during authentication verification" },
      500 
    );
  }
} 