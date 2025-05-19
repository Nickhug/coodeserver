import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { verifyToken as clerkVerifyToken } from "@clerk/backend";
import { cookies } from "next/headers";
import axios from 'axios';
import { getUserByClerkId, createUser, storeAuthToken } from "@repo/db";
import { generateToken } from "@repo/auth";
import logger from "@repo/logger";

// Get the WebSocket server base URL from environment variables or use the default
const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_SERVER_URL || 'ws://gondola.proxy.rlwy.net:28028/ws';

// For debugging
logger.info(`Using WebSocket server URL: ${WS_BASE_URL}`);

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
      id: userId, // Use clerk_id as the ID for consistency
      uuid: dbUser.id, // Include the database UUID as a separate field
      email: dbUser.email,
      credits: dbUser.credits_remaining,
      subscription: dbUser.subscription_tier
    };

    // Generate a token for the client
    const token = generateToken();

    // Store the token in the database with a 5-minute expiry
    logger.info(`Storing token for Clerk user ${userId}, expires at ${new Date(Date.now() + 5 * 60 * 1000).toISOString()}`);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
    const storedToken = await storeAuthToken(token, userId, expiresAt);

    if (!storedToken) {
      logger.error(`Failed to store auth token for user ${userId}`);
      return NextResponse.json({
        success: false,
        message: "Failed to store authentication token"
      }, { status: 500 });
    }

    logger.info(`Successfully stored auth token for user ${userId}`);

    // Send auth data to the WebSocket server via its HTTP API
    try {
      // Parse the WebSocket URL to correctly extract host and port
      let baseUrl;
      try {
        // Create a URL object from the WebSocket URL
        const wsUrl = new URL(WS_BASE_URL);
        
        // Convert protocol from ws/wss to http/https
        const protocol = wsUrl.protocol === 'ws:' ? 'http:' : 'https:';
        
        // Construct the base URL without the /ws path
        baseUrl = `${protocol}//${wsUrl.host}`;
        
        logger.info(`Constructed base URL: ${baseUrl} from WebSocket URL: ${WS_BASE_URL}`);
      } catch (urlError) {
        logger.error(`Error parsing WebSocket URL: ${urlError}`);
        // Fallback to simple string replacement if URL parsing fails
        baseUrl = WS_BASE_URL.replace(/^ws:\/\//, 'http://')
                            .replace(/^wss:\/\//, 'https://')
                            .replace(/\/ws$/, '');
        logger.info(`Fallback base URL: ${baseUrl}`);
      }
      
      const authUrl = `${baseUrl}/api/auth`;
      
      // Log the URL we're going to call for debugging
      logger.info(`Sending auth data to WebSocket server at: ${authUrl}`);
      logger.info(`Using connection ID: ${connectionId}`);
      
      // Add timeout and retry logic
      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 1000;
      const REQUEST_TIMEOUT_MS = 5000;
      
      let retries = 0;
      let success = false;
      let lastError;
      let responseData = null;
      
      while (retries <= MAX_RETRIES && !success) {
        try {
          if (retries > 0) {
            logger.info(`Retry attempt #${retries} for connection ${connectionId}`);
            // Wait a bit between retries
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * retries));
          }
          
          // First check if the connection exists by requesting connection status
          const checkUrl = `${baseUrl}/api/debug/connections`;
          let connectionExists = false;

          try {
            logger.info(`Checking connection status at: ${checkUrl}`);
            const checkResponse = await axios.get(checkUrl, { timeout: REQUEST_TIMEOUT_MS });
            if (checkResponse.status === 200 && checkResponse.data.connections) {
              const connections = checkResponse.data.connections;
              connectionExists = connections.some((conn: any) => conn.id === connectionId);
              
              if (!connectionExists) {
                logger.warn(`Connection ID ${connectionId} not found on server. Active connections: ${connections.length}`);
                logger.info(`Active connection IDs: ${connections.map((c: any) => c.id).join(', ')}`);
                // Don't retry if the connection doesn't exist at all
                throw new Error('Connection not found on server');
              } else {
                logger.info(`Found connection ${connectionId} on server`);
              }
            }
          } catch (checkError) {
            // Debug endpoint might be disabled in production, so continue anyway
            logger.info('Could not check connection status, continuing with auth attempt');
            logger.error('Check connection error:', checkError);
          }
          
          // Send the auth data
          logger.info(`Sending auth request to ${authUrl} with data:`, {
            connectionId,
            tokenLength: token.length,
            userData: { ...userData, id: '***', uuid: '***' } // Mask sensitive data
          });
          
          const response = await axios.post(authUrl, 
            {
              connectionId,
              token,
              userData
            },
            {
              headers: {
                'Content-Type': 'application/json',
              },
              timeout: REQUEST_TIMEOUT_MS
            }
          );

          responseData = response.data;
          logger.info(`Auth response status: ${response.status}, data:`, responseData);
          
          if (response.status === 200 && response.data.success) {
            logger.info(`Successfully sent auth data to WebSocket for connection ${connectionId}`);
            success = true;
          } else {
            throw new Error(`WebSocket server responded with unexpected status: ${JSON.stringify(response.data)}`);
          }
        } catch (err) {
          lastError = err;
          retries++;
          
          if (axios.isAxiosError(err) && err.response && err.response.status === 404) {
            // If the connection wasn't found, don't retry - it's gone
            if (err.response.data && typeof err.response.data === 'object' && 
                'message' in err.response.data && 
                typeof err.response.data.message === 'string' && 
                err.response.data.message.includes('Connection not found')) {
              logger.error(`Connection ${connectionId} not found on WebSocket server, won't retry`);
              break;
            }
          }
          
          logger.warn(`Error on attempt #${retries}: ${err}`);
        }
      }
      
      if (!success) {
        // Format error message for better debugging
        let errorMsg = 'Failed to send auth data to WebSocket server after retries';
        let errorDetails = '';
        
        if (lastError) {
          if (axios.isAxiosError(lastError)) {
            if (lastError.response) {
              errorDetails = ` - ${lastError.response.status} ${lastError.response.statusText}`;
              logger.error(`Response data:`, lastError.response.data);
            } else if (lastError.request) {
              errorDetails = ' - No response received';
            } else {
              errorDetails = ` - ${lastError.message}`;
            }
          } else if (lastError instanceof Error) {
            errorDetails = ` - ${lastError.message}`;
          } else {
            errorDetails = ` - Unknown error object: ${JSON.stringify(lastError)}`;
          }
        }
        
        throw new Error(errorMsg + errorDetails);
      }

      logger.info(`Found user UUID ${dbUser.id} for clerk_id ${userId}`);
      return NextResponse.json({ success: true });
    } catch (wsError) {
      logger.error("Error sending auth to WebSocket server:", wsError);
      
      // Extract more detailed error info for debugging
      let details = '';
      if (axios.isAxiosError(wsError) && wsError.response) {
        details = ` - ${wsError.response.status} ${wsError.response.statusText}`;
        logger.error(`Response data:`, wsError.response.data);
      }
      
      return NextResponse.json({
        success: false,
        message: `Failed to send auth data to WebSocket server${details}`
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
