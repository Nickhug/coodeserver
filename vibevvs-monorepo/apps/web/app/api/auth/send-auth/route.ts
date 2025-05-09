import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { verifyToken as clerkVerifyToken } from "@clerk/backend";
import { cookies } from "next/headers";
import axios from 'axios';
import { getUserByClerkId, createUser, storeAuthToken } from "@repo/db";
import { generateToken } from "@repo/auth";
import logger from "@repo/logger";

// Get the WebSocket server base URL from environment variables or use a default
const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_SERVER_URL || 'http://localhost:8080';

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
      logger.warn("Clerk middleware auth failed, falling back to manual token verification:", authError);

      // If middleware auth fails, try to manually verify the session token
      const cookieStore = await cookies();
      const sessionToken = cookieStore.get("__session")?.value;

      if (sessionToken) {
        try {
          // Verify the token using Clerk's Backend SDK directly
          const claims = await clerkVerifyToken(sessionToken, {
            secretKey: process.env.CLERK_SECRET_KEY,
          });

          // Extract user ID from the verified token
          userId = claims.sub || null;
        } catch (tokenError) {
          logger.error("Token verification failed:", tokenError);
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
    logger.info(`Attempting to fetch user with Clerk ID: ${userId}`);
    let dbUser;

    try {
      dbUser = await getUserByClerkId(userId);

      if (!dbUser) {
        logger.info(`User with Clerk ID ${userId} not found in database. Creating a new user record.`);

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

        logger.info(`Created new user with ID: ${newUser.id}`);
        dbUser = newUser;
      }

      // Continue with the existing user
      logger.info(`Found user in database: ${dbUser.id}`);
    } catch (dbError) {
      logger.error("Error fetching/creating user:", dbError);
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
    logger.info(`Storing auth token for user ${dbUser.clerk_id}`);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
    const storedToken = await storeAuthToken(token, dbUser.clerk_id, expiresAt);

    if (!storedToken) {
      logger.error(`Failed to store auth token for user ${dbUser.clerk_id}`);
      return NextResponse.json({
        success: false,
        message: "Failed to store authentication token"
      }, { status: 500 });
    }

    logger.info(`Successfully stored auth token for user ${dbUser.clerk_id}`);

    // Send auth data to the WebSocket server via its HTTP API
    try {
      const response = await axios.post(`${WS_BASE_URL}/api/auth`, {
        connectionId,
        token,
        userData
      });

      if (response.status !== 200) {
        throw new Error(`WebSocket server responded with status ${response.status}`);
      }

      return NextResponse.json({ success: true });
    } catch (wsError) {
      logger.error("Error sending auth to WebSocket server:", wsError);
      return NextResponse.json({
        success: false,
        message: "Failed to send auth data to WebSocket server"
      }, { status: 500 });
    }
  } catch (error) {
    logger.error("Error sending auth to WebSocket:", error);
    return NextResponse.json({
      success: false,
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, { status: 500 });
  }
}
