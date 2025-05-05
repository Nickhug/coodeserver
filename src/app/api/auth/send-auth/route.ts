import { NextRequest, NextResponse } from "next/server";
import { createClerkClient } from "@clerk/nextjs/server";
import { getUser } from "../../../../lib/supabase/client";
import { cookies, headers } from "next/headers";

/**
 * API route to send authentication data to a WebSocket connection
 */
export async function POST(req: NextRequest) {
  try {
    // Get the session token from cookies
    const cookieStore = await cookies();
    const sessionToken = cookieStore.get("__session")?.value;

    if (!sessionToken) {
      return NextResponse.json({ success: false, message: "No session token found" }, { status: 401 });
    }

    // Create a Clerk client
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY
    });

    try {
      // Verify the session token
      const session = await clerk.sessions.verifySession(sessionToken);
      const userId = session.userId;

      if (!userId) {
        return NextResponse.json({ success: false, message: "Invalid session" }, { status: 401 });
      }

      // Get the connection ID from the request
      const { connectionId } = await req.json();

      if (!connectionId) {
        return NextResponse.json({ success: false, message: "Missing connection ID" }, { status: 400 });
      }

      // Get user data from our database
      const dbUser = await getUser(userId);

      if (!dbUser) {
        return NextResponse.json({
          success: false,
          message: "User not found in database"
        }, { status: 404 });
      }

      // Prepare user data to be sent
      const userData = {
        id: dbUser.id,
        email: dbUser.email,
        credits: dbUser.credits_remaining,
        subscription: dbUser.subscription_tier
      };

      // Generate a token for the client
      const token = generateToken();

      // Use the global sendAuthSuccess function to send auth data to the WebSocket
      // This function is defined in server.js
      const success = (global as any).sendAuthSuccess?.(connectionId, token, userData);

      if (!success) {
        return NextResponse.json({
          success: false,
          message: "Failed to send auth data to WebSocket connection"
        }, { status: 500 });
      }

      return NextResponse.json({ success: true });
    } catch (clerkError) {
      console.error("Clerk authentication error:", clerkError);
      return NextResponse.json({
        success: false,
        message: `Authentication error: ${clerkError instanceof Error ? clerkError.message : 'Unknown error'}`
      }, { status: 401 });
    }
  } catch (error) {
    console.error("Error sending auth to WebSocket:", error);
    return NextResponse.json({
      success: false,
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, { status: 500 });
  }
}

/**
 * Generate a simple token for authentication
 */
function generateToken(): string {
  return Array.from(
    { length: 32 },
    () => Math.floor(Math.random() * 36).toString(36)
  ).join('');
}
