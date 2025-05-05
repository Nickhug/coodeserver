import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { createUser, getUser, storeAuthToken, deleteExpiredAuthTokens } from "../../../../lib/supabase/client";
import crypto from 'crypto';

export async function GET(req: NextRequest) {
  // Use auth() to get the user's ID
  const { userId } = await auth();

  // Check for connection ID from WebSocket
  const connectionId = req.nextUrl.searchParams.get('connection_id');

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
        throw new Error("Failed to create user in database during callback");
      }
    }

    // --- Token Generation and Storage ---
    await deleteExpiredAuthTokens(); // Clean up old tokens
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // Token valid for 5 minutes

    const storedToken = await storeAuthToken(token, userId, expiresAt);
    if (!storedToken) {
      throw new Error("Failed to store auth token");
    }

    // Prepare user data to be sent
    const userData = {
      id: dbUser.id,
      email: dbUser.email,
      credits: dbUser.credits_remaining,
      subscription: dbUser.subscription_tier
    };

    // If we have a connection ID, try to send auth data via WebSocket
    if (connectionId) {
      try {
        // Use the global sendAuthSuccess function to send auth data to the WebSocket
        // This function is defined in server.js
        const success = (global as any).sendAuthSuccess?.(connectionId, token, userData);

        if (success) {
          console.log(`Successfully sent auth data to WebSocket connection ${connectionId}`);
        } else {
          console.warn(`Failed to send auth data to WebSocket connection ${connectionId}`);
        }
      } catch (wsError) {
        console.error(`Error sending auth data to WebSocket: ${wsError}`);
      }
    }

    // Always redirect with token in URL
    const redirectUrl = new URL("/", req.url);
    redirectUrl.searchParams.set('auth_token', token);
    const response = NextResponse.redirect(redirectUrl);

    // Set cookie with user data - secure in production, accessible to Void
    response.cookies.set({
      name: "vvs_auth_info",
      value: JSON.stringify(userData),
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