import { WebSocketServer, WebSocket } from 'ws';
import { auth } from '@clerk/nextjs/server';
import { getUser } from '@/lib/supabase/client';
import { Server } from 'http';

// Map to store connections by ID
const connections = new Map<string, WebSocket>();

// Store the WebSocket server instance
let wss: WebSocketServer | null = null;

// Helper function to verify auth (similar to the one in verify/route.ts)
async function checkAuthStatus() {
  try {
    const session = await auth();
    const clerkUserId = session?.userId;

    if (!clerkUserId) {
      return { authenticated: false };
    }
    
    const dbUser = await getUser(clerkUserId);
    if (!dbUser) {
      return { authenticated: false };
    }

    return { 
      authenticated: true,
      user: {
        id: dbUser.id,
        email: dbUser.email,
        credits: dbUser.credits_remaining,
        subscription: dbUser.subscription_tier
      }
    };
  } catch (error) {
    console.error("WebSocket auth check error:", error);
    return { authenticated: false };
  }
}

// Initialize the WebSocket server
export function initWebSocketServer(server: Server) {
  // Create WebSocket server instance if it doesn't already exist
  if (!wss) {
    wss = new WebSocketServer({ 
      server,
      path: '/api/ws',
    });

    wss.on('connection', async (ws: WebSocket) => {
      // Generate a unique connection ID
      const connectionId = Math.random().toString(36).substring(2, 15);
      
      // Store the connection
      connections.set(connectionId, ws);
      
      // Send the connection ID to the client
      ws.send(JSON.stringify({ 
        type: 'connection',
        connectionId 
      }));

      // Handle incoming messages
      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          
          if (data.type === 'auth:poll') {
            // Client is polling for auth status
            const authResult = await checkAuthStatus();
            ws.send(JSON.stringify({
              type: 'auth:status',
              authenticated: authResult.authenticated,
              user: authResult.user
            }));
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Invalid message format' 
          }));
        }
      });

      // Handle disconnection
      ws.on('close', () => {
        connections.delete(connectionId);
      });
    });
  }

  return wss;
}

// Type for user data
type UserData = {
  id: string;
  email: string;
  [key: string]: unknown;
};

// Send authentication success to a specific client by connection ID
export function sendAuthSuccess(connectionId: string, token: string, userData: UserData) {
  const ws = connections.get(connectionId);
  
  if (ws) {
    ws.send(JSON.stringify({
      type: 'auth:success',
      token,
      user: userData
    }));
    return true;
  }
  
  return false;
} 