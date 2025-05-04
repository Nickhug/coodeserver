import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { createUser, getUser } from "../../../../lib/supabase/client";

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.userId;
  
  // If no user ID, redirect to homepage with error
  if (!userId) {
    return NextResponse.redirect(new URL("/?error=auth_failed", req.url));
  }
  
  try {
    // Get user from Clerk using clerkClient
    const client = await clerkClient();
    const clerkUser = await client.users.getUser(userId);
    
    if (!clerkUser || !clerkUser.emailAddresses[0]?.emailAddress) {
      return NextResponse.redirect(new URL("/?error=no_email", req.url));
    }
    
    const email = clerkUser.emailAddresses[0].emailAddress;
    
    // Check if user exists in our database
    let dbUser = await getUser(userId);
    
    // If not, create user in our DB
    if (!dbUser) {
      dbUser = await createUser(userId, email);
      
      if (!dbUser) {
        throw new Error("Failed to create user in database");
      }
    }
    
    // Set auth cookie for Void editor to verify
    const response = NextResponse.redirect(new URL("/", req.url));
    
    // Set cookie with user data - secure in production, accessible to Void
    response.cookies.set({
      name: "vvs_auth",
      value: JSON.stringify({
        userId,
        email,
        credits: dbUser.credits_remaining,
        subscription: dbUser.subscription_tier
      }),
      httpOnly: false, // Allow Void to read this cookie
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7 // 1 week
    });
    
    return response;
  } catch (error) {
    console.error("Auth callback error:", error);
    return NextResponse.redirect(new URL("/?error=server_error", req.url));
  }
} 