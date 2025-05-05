import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getUser, createUser, storeAuthToken } from "../../../../lib/supabase/client";
import { verifyToken } from "@clerk/backend";
import { cookies } from "next/headers";

/**
 * API route to send authentication data to a WebSocket connection
 */
export async function POST(req: NextRequest) {
  try {
    // Try to get the user ID from the auth helper first
    let userId: string | null = null;

    try {
      // Try using the Next.js middleware auth helper
      const session = await auth();
      userId = session?.userId || null;
    } catch (authError) {
      console.warn("Clerk middleware auth failed, falling back to manual token verification:", authError);

      // If middleware auth fails, try to manually verify the session token
      const cookieStore = await cookies();
      const sessionToken = cookieStore.get("__session")?.value;

      if (sessionToken) {
        try {
          // Verify the token using Clerk's Backend SDK directly
          const claims = await verifyToken(sessionToken, {
            secretKey: process.env.CLERK_SECRET_KEY,
          });

          // Extract user ID from the verified token
          userId = claims.sub || null;
        } catch (tokenError) {
          console.error("Token verification failed:", tokenError);
        }
      }
    }

    if (!userId) {
      return NextResponse.json({ success: false, message: "Not authenticated" }, { status: 401 });
    }

    // Get the connection ID from the request
    const { connectionId } = await req.json();

    if (!connectionId) {
      return NextResponse.json({ success: false, message: "Missing connection ID" }, { status: 400 });
    }

    // Get user data from our database
    console.log(`Attempting to fetch user with Clerk ID: ${userId}`);
    let dbUser;

    try {
      dbUser = await getUser(userId);

      if (!dbUser) {
        console.log(`User with Clerk ID ${userId} not found in database. Creating a new user record.`);

        // Try to create a new user if they don't exist
        // We need to get the email from Clerk, but we don't have it here
        // For now, use a placeholder email and let the user update it later
        const placeholderEmail = `${userId}@placeholder.com`;
        const newUser = await createUser(userId, placeholderEmail);

        if (!newUser) {
          return NextResponse.json({
            success: false,
            message: "Failed to create user in database"
          }, { status: 500 });
        }

        console.log(`Created new user with ID: ${newUser.id}`);
        dbUser = newUser;
      }

      // Continue with the existing user
      console.log(`Found user in database: ${dbUser.id}`);
    } catch (dbError) {
      console.error("Error fetching/creating user:", dbError);
      return NextResponse.json({
        success: false,
        message: `Database error: ${dbError instanceof Error ? dbError.message : 'Unknown error'}`
      }, { status: 500 });
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

    // Store the token in the database with a 5-minute expiry
    console.log(`Storing auth token for user ${dbUser.clerk_id}`);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
    const storedToken = await storeAuthToken(token, dbUser.clerk_id, expiresAt);

    if (!storedToken) {
      console.error(`Failed to store auth token for user ${dbUser.clerk_id}`);
      return NextResponse.json({
        success: false,
        message: "Failed to store authentication token"
      }, { status: 500 });
    }

    console.log(`Successfully stored auth token for user ${dbUser.clerk_id}`);

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
