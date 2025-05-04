import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "../../../../lib/supabase/client";

/**
 * API route that verifies a user's authentication status
 * Can verify based on Clerk session OR the vvs_auth cookie set during callback.
 */
export async function GET(req: NextRequest) {
  try {
    // 1. Check Clerk session first
    const session = await auth();
    const clerkUserId = session?.userId;

    if (clerkUserId) {
      const dbUser = await getUser(clerkUserId);
      if (dbUser) {
        return NextResponse.json({
          authenticated: true,
          user: {
            id: dbUser.id,
            email: dbUser.email,
            credits: dbUser.credits_remaining,
            subscription: dbUser.subscription_tier
          }
        });
      } else {
         // Clerk user exists but not in our DB (should ideally not happen after callback)
        return NextResponse.json(
          { authenticated: false, message: "User found in auth provider but not in database" },
          { status: 404 }
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
            return NextResponse.json(
              { authenticated: false, message: "User from cookie not found in database" },
              { status: 404 }
            );
          }
          // If user exists, trust cookie data set by our callback
          return NextResponse.json({
            authenticated: true,
            user: { id: userId, email, credits, subscription }
          });
        } else {
           return NextResponse.json(
            { authenticated: false, message: "Invalid data in vvs_auth cookie" },
            { status: 400 }
          );
        }
      } catch (parseError) {
         console.error("Failed to parse vvs_auth cookie:", parseError);
         return NextResponse.json(
          { authenticated: false, message: `Failed to parse vvs_auth cookie: ${(parseError as Error).message}` },
          { status: 400 }
        );
      }
    }

    // 3. If neither method works, user is not authenticated
    return NextResponse.json(
      { authenticated: false, message: "User not authenticated" },
      { status: 401 }
    );

  } catch (error) {
    console.error("Verify auth error:", error);
    return NextResponse.json(
      { authenticated: false, message: "Server error during authentication verification" },
      { status: 500 }
    );
  }
} 