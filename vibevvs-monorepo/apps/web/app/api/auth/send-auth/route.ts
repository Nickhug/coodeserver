import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import axios from 'axios';
import { getUserByClerkId, createUser, storeAuthToken } from "@repo/db";
import { generateToken } from "@repo/auth";
import logger from "@repo/logger";

// Get the WebSocket server base URL from environment variables or use the default
const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_SERVER_URL || 'ws://gondola.proxy.rlwy.net:28028/ws';

// For debugging
logger.info(`Using WebSocket server URL: ${WS_BASE_URL}`);

// Support both GET and POST methods to handle redirects from login and direct POST requests
export async function GET(request: NextRequest) {
  return handleAuthRequest(request);
}

export async function POST(request: NextRequest) {
  return handleAuthRequest(request);
}

// Combined handler for both GET and POST
async function handleAuthRequest(request: NextRequest) {
  try {
    // Get auth session to verify user is logged in
    const session = await auth();
    const userId = session.userId;
    
    if (!userId) {
      return NextResponse.json(
        { success: false, message: 'Not authenticated' },
        { status: 401 }
      );
    }
    
    // Get connection_id from query params (GET) or request body (POST)
    let connectionId: string | null = null;
    
    // Check URL params first (for GET redirects from login)
    const url = new URL(request.url);
    connectionId = url.searchParams.get('connection_id');
    
    // If not in URL params, try to get from request body (for POST requests)
    if (!connectionId && request.method === 'POST') {
      try {
        const body = await request.json();
        connectionId = body.connectionId;
      } catch (e) {
        // Ignore JSON parsing errors
      }
    }

    if (!connectionId) {
      return NextResponse.json(
        { success: false, message: 'Missing connection_id parameter' },
        { status: 400 }
      );
    }

    // Get user data from database - the rest of the function stays mostly the same
    logger.info(`Fetching user with Clerk ID: ${userId}`);
    let dbUser = await getUserByClerkId(userId);

    if (!dbUser) {
      // Create user if they don't exist yet
      logger.info(`User not found in database. Creating a new user record.`);
      const email = `${userId}@placeholder.com`; // Replace with actual email from Clerk if available
      dbUser = await createUser(userId, email);
      
      if (!dbUser) {
        return NextResponse.json({
          success: false,
          message: "Failed to create user in database"
        }, { status: 500 });
      }
    }

    // Prepare user data to send to VVS
    const userData = {
      id: userId,
      uuid: dbUser.id,
      email: dbUser.email,
      credits: dbUser.credits_remaining,
      subscription: dbUser.subscription_tier
    };

    // Generate a token for VVS
    const token = generateToken();
    
    // Store the token with a 5-minute expiry
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const storedToken = await storeAuthToken(token, userId, expiresAt);
    
    if (!storedToken) {
      return NextResponse.json({
        success: false,
        message: "Failed to store authentication token"
      }, { status: 500 });
    }
    
    // Send auth data to the WebSocket server
    try {
      // Convert WS URL to HTTP URL
      const wsUrl = new URL(WS_BASE_URL);
      const protocol = wsUrl.protocol === 'ws:' ? 'http:' : 'https:';
      const baseUrl = `${protocol}//${wsUrl.host}`;
      const authUrl = `${baseUrl}/api/auth`;
      
      // Send auth data to WS server
      const response = await axios.post(authUrl, {
        connectionId,
        token,
        userData
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000 // 5 second timeout
      });
      
      if (response.status === 200 && response.data.success) {
        // If this was a GET request from browser redirect, return a success page
        if (request.method === 'GET') {
          return new NextResponse(
            `
            <html>
              <head>
                <title>Authentication Complete</title>
                <style>
                  body { 
                    font-family: system-ui, sans-serif; 
                    background-color: #000; 
                    color: #fff;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    text-align: center;
                  }
                  .container {
                    max-width: 500px;
                    padding: 2rem;
                    background-color: rgba(255,255,255,0.05);
                    border-radius: 0.5rem;
                    border: 1px solid rgba(255,255,255,0.1);
                  }
                  h1 { color: #d81b60; }
                  p { color: rgba(255,255,255,0.8); }
                </style>
              </head>
              <body>
                <div class="container">
                  <h1>Authentication Complete</h1>
                  <p>You have been successfully authenticated with VVS.</p>
                  <p>You can now close this window and return to your editor.</p>
                </div>
              </body>
            </html>
            `,
            { status: 200, headers: { 'Content-Type': 'text/html' } }
          );
        }
        
        // For POST requests, return JSON success
        return NextResponse.json({ success: true });
      } else {
        throw new Error(`WebSocket server response: ${JSON.stringify(response.data)}`);
      }
    } catch (wsError) {
      logger.error("Error sending auth to WebSocket server:", wsError);
      return NextResponse.json({
        success: false,
        message: `Failed to send auth data to WebSocket server: ${wsError instanceof Error ? wsError.message : 'Unknown error'}`
      }, { status: 500 });
    }
  } catch (error) {
    logger.error("Error in auth handling:", error);
    return NextResponse.json({
      success: false,
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, { status: 500 });
  }
}
