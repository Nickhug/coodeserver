import { Server, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from '@clerk/backend'; // Import verifyToken directly
import { URL } from 'url';

// Store connections mapped by connectionId, including authenticated userId
interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
}
const connections = new Map<string, AuthenticatedWebSocket>();
let wss: WebSocketServer | null = null;

// Type for user data passed around
export type UserData = {
  id: string;
  email: string;
  [key: string]: unknown;
};

// No Clerk client instance needed if only using verifyToken

// Exported function to send auth success message via WebSocket
export function sendAuthSuccess(connectionId: string, token: string, userData: UserData) {
  const ws = connections.get(connectionId);
  console.log(`Attempting to send auth success to ${connectionId}`);
  if (ws) {
    ws.send(JSON.stringify({
      type: 'auth:success',
      token,
      user: userData
    }));
    console.log(`Sent auth success to ${connectionId}`);
    return true;
  } else {
    console.log(`WebSocket connection ${connectionId} not found.`);
  }
  return false;
}

/**
 * Initializes the WebSocket server, attaching it to the provided HTTP server.
 * Includes authentication logic using Clerk during the handshake.
 */
export function initWebSocketServer(server: Server) {
  if (wss) {
    console.warn("WebSocket server already initialized.");
    return;
  }

  console.log("Initializing WebSocket server...");
  wss = new WebSocketServer({
    server,
    path: '/api/ws', // Ensure path matches client requests
    verifyClient: async (info: { origin: string; secure: boolean; req: IncomingMessage }, callback) => {
      console.log(`[WebSocket Auth] Verifying client from origin: ${info.origin}`);

      const url = new URL(info.req.url || '', `http://${info.req.headers.host}`);
      const sessionToken = url.searchParams.get('__session'); // Clerk token often passed as '__session' query param

      if (!sessionToken) {
        console.error('[WebSocket Auth] Failed: No session token provided.');
        return callback(false, 401, 'Unauthorized: No token');
      }

      try {
        const claims = await verifyToken(sessionToken, {
          secretKey: process.env.CLERK_SECRET_KEY,
          // Add other verification options if needed (e.g., authorizedParty, clockSkew)
        });
        if (!claims.sub) {
          console.error('[WebSocket Auth] Failed: Invalid token claims (no sub).');
          return callback(false, 401, 'Unauthorized: Invalid token');
        }
        const userId = claims.sub;
        console.log(`[WebSocket Auth] Success: Token verified for user ${userId}`);

        // Attach userId to the request object to be used in the 'connection' event
        (info.req as any).userId = userId;

        return callback(true); // Authentication successful
      } catch (error: any) {
        console.error(`[WebSocket Auth] Failed: Token verification error: ${error.message}`);
        return callback(false, 401, `Unauthorized: ${error.message}`);
      }
    },
  });
  console.log("WebSocket server initialized. Setting up event listeners...");

  wss.on('connection', (ws: AuthenticatedWebSocket, req: IncomingMessage) => {
    const connectionId = Math.random().toString(36).substring(2, 15);
    const userId = (req as any).userId; // Retrieve userId attached during verifyClient

    if (!userId) {
      console.error(`[WebSocket Manager] Connection rejected for ${connectionId}: Missing user ID after auth.`);
      ws.terminate();
      return;
    }

    console.log(`[WebSocket Manager] Connection attempt received. Assigning ID: ${connectionId}`);

    try {
      ws.userId = userId; // Store userId on the WebSocket object itself
      connections.set(connectionId, ws);
      console.log(`[WebSocket Manager] Client connected and stored: ${connectionId} for user ${userId}`);

      // Send connection ID back to the client
      ws.send(JSON.stringify({ type: 'connection', connectionId }));
      console.log(`[WebSocket Manager] Sent connectionId ${connectionId} to client.`);

    } catch (error) {
      console.error(`[WebSocket Manager] Error during initial connection setup for ${connectionId}:`, error);
      try {
        ws.terminate(); // Attempt to close the connection gracefully on error
      } catch (terminateError) {
        console.error(`[WebSocket Manager] Error terminating WebSocket for ${connectionId} after setup error:`, terminateError);
      }
      return; // Stop further setup if initial phase failed
    }

    ws.on('message', async (message) => {
      console.log(`[WebSocket Manager] Received message from ${connectionId}: ${message}`);
      try {
        const parsedMessage = JSON.parse(message.toString());

        // Remove auth:poll handling, auth is done at connection time
        if (parsedMessage.type === 'auth:poll') {
          console.warn(`[WebSocket Manager] Received deprecated 'auth:poll' from ${connectionId}. Auth now happens at connection.`);
          // Optionally send back a message indicating successful connection-time auth
          ws.send(JSON.stringify({ type: 'auth:status', authenticated: true, userId: ws.userId }));
        } else {
          // Handle other message types here...
          console.log(`[WebSocket Manager] Handling message type ${parsedMessage.type} for ${connectionId}`);
        }
      } catch (error) {
        console.error(`[WebSocket Manager] Error processing message from ${connectionId}:`, error);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to process message' }));
      }
    });

    ws.on('close', () => {
      connections.delete(connectionId);
      console.log(`[WebSocket Manager] Client disconnected: ${connectionId}`);
    });

    ws.on('error', (error) => {
      console.error(`[WebSocket Manager] WebSocket error for ${connectionId}:`, error);
      connections.delete(connectionId); // Ensure cleanup on error
    });
  });

  wss.on('error', (error) => {
    console.error("FATAL: WebSocketServer emitted error:", error);
    // Depending on the error, you might want to attempt recovery or shutdown
  });

  console.log("WebSocket event listeners set up.");
}
