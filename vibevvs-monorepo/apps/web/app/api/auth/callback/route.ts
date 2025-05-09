import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { createUser, getUser, storeAuthToken, deleteExpiredAuthTokens } from "../../../../lib/supabase/client";
import crypto from 'crypto';
import axios from 'axios';

// Get the WebSocket server base URL from environment variables or use a default
const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_SERVER_URL || 'http://localhost:8080';

export async function GET(req: NextRequest) {
  try {
    // Get the user ID from the auth helper
    const { userId } = await auth();

    // Check for connection ID from WebSocket
    const connectionId = req.nextUrl.searchParams.get('connection_id');

    // If no user ID, redirect to homepage with error
    if (!userId) {
      return NextResponse.redirect(new URL("/?error=auth_failed", req.url));
    }

    // Get user from database
    let dbUser = await getUser(userId);
    const email = "user@example.com"; // Default email

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
    interface UserData {
      id: string | number; // Assuming id can be string or number based on dbUser types
      email: string | null;
      credits: number | null;
      subscription: string | null;
    }
    const userData: UserData = {
      id: dbUser.id,
      email: dbUser.email,
      credits: dbUser.credits_remaining,
      subscription: dbUser.subscription_tier
    };

    // If we have a connection ID, try to send auth data via WebSocket
    if (connectionId) {
      try {
        // Send auth data to the WebSocket server via its HTTP API
        const response = await axios.post(`${WS_BASE_URL}/api/auth`, {
          connectionId,
          token,
          userData
        });

        if (response.status === 200) {
          console.log(`Successfully sent auth data to WebSocket connection ${connectionId}`);
        } else {
          console.warn(`Failed to send auth data to WebSocket connection ${connectionId}: ${response.status}`);
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