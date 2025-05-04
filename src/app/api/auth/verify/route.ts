import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getUser } from "../../../../lib/supabase/client";

/**
 * API route that verifies a user's authentication status
 * This will be called by the Void editor to check if a user is authenticated
 */
export async function GET() {
  try {
    // Get authentication from Clerk
    const session = await auth();
    const userId = session?.userId;
    
    // If no user ID, return unauthorized
    if (!userId) {
      return NextResponse.json(
        { 
          authenticated: false,
          message: "User not authenticated" 
        },
        { status: 401 }
      );
    }
    
    // Get user from our database
    const dbUser = await getUser(userId);
    
    if (!dbUser) {
      return NextResponse.json(
        { 
          authenticated: false,
          message: "User not found in database"
        },
        { status: 404 }
      );
    }
    
    // Return user data that the editor can use
    return NextResponse.json({
      authenticated: true,
      user: {
        id: dbUser.id,
        email: dbUser.email,
        credits: dbUser.credits_remaining,
        subscription: dbUser.subscription_tier
      }
    });
  } catch (error) {
    console.error("Verify auth error:", error);
    return NextResponse.json(
      { 
        authenticated: false,
        message: "Server error during authentication verification"
      },
      { status: 500 }
    );
  }
} 