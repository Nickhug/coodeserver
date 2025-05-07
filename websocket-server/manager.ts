import { Server, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from '@clerk/backend';
import { URL } from 'url';

// Interface definitions for imported types
export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, unknown>;
}

// StreamContext from ActiveStreamManager (subset to avoid circular dependencies)
export interface StreamContext {
  controller: ReadableStreamDefaultController;
  systemMessage?: string;
  tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  userId: string;
}

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

// Type for tool-related messages
export interface ExecuteToolMessage {
  type: 'executeTool';
  requestId: string;
  toolCall: ToolCall;
}

export interface ToolResultMessage {
  type: 'toolResult';
  requestId: string;
  toolCallId: string;
  output: unknown;
}

// General event structure for client communication
export interface BaseClientEvent {
  type: string;
  requestId: string; // requestId is now mandatory for all client events for routing
}

export interface GeminiStartEvent extends BaseClientEvent { type: 'geminiStart'; }
export interface GeminiContentEvent extends BaseClientEvent { type: 'geminiContent'; chunk: string; }
export interface GeminiDoneEvent extends BaseClientEvent { type: 'geminiDone'; }
export interface GeminiErrorEvent extends BaseClientEvent { type: 'geminiError'; error: string; message?: string; [key: string]: unknown; }
export interface ExecuteToolClientEvent extends BaseClientEvent, ExecuteToolMessage { type: 'executeTool'; }

export type ClientEvent = 
  | GeminiStartEvent
  | GeminiContentEvent
  | ExecuteToolClientEvent // This now correctly includes all fields from ExecuteToolMessage
  | GeminiDoneEvent
  | GeminiErrorEvent;

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
 * Sends a tool execution request to the client via WebSocket
 */
export function sendToolExecutionRequest(userId: string, toolExecutionRequest: ExecuteToolMessage): boolean {
  // Construct the event that matches ExecuteToolClientEvent structure
  const event: ExecuteToolClientEvent = {
    ...toolExecutionRequest, // Spread properties from toolExecutionRequest
    type: 'executeTool',    // Explicitly set type
    requestId: toolExecutionRequest.requestId // Ensure requestId is set
  };
  return sendEventToClient(userId, event);
}

/**
 * Sends a generic event to all WebSocket connections for a given user.
 */
export function sendEventToClient(userId: string, event: ClientEvent): boolean {
  let sent = false;
  console.log(`[WebSocket Manager] Attempting to send event type ${event.type} for requestId ${event.requestId} to user ${userId}`);
  for (const [connectionId, ws] of connections.entries()) {
    if (ws.userId === userId) {
      try {
        ws.send(JSON.stringify(event)); // event already includes requestId
        console.log(`[WebSocket Manager] Sent event ${event.type} to connection ${connectionId} for user ${userId}`);
        sent = true;
      } catch (error) {
        console.error(`[WebSocket Manager] Error sending event ${event.type} to ${connectionId}:`, error);
      }
    }
  }
  if (!sent) {
    console.warn(`[WebSocket Manager] No active WebSocket connections found for user ${userId} to send event ${event.type}`);
  }
  return sent;
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
        (info.req as unknown as { userId: string }).userId = userId;

        return callback(true); // Authentication successful
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[WebSocket Auth] Failed: Token verification error: ${errorMessage}`);
        return callback(false, 401, `Unauthorized: ${errorMessage}`);
      }
    },
  });
  console.log("WebSocket server initialized. Setting up event listeners...");

  wss.on('connection', (ws: AuthenticatedWebSocket, req: IncomingMessage) => {
    const connectionId = Math.random().toString(36).substring(2, 15);
    // Safely access userId from request
    const userId = (req as unknown as { userId?: string }).userId;

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
      console.log(`[WebSocket Manager] Received message from ${connectionId}`);
      try {
        const parsedMessage = JSON.parse(message.toString());

        // Remove auth:poll handling, auth is done at connection time
        if (parsedMessage.type === 'auth:poll') {
          console.warn(`[WebSocket Manager] Received deprecated 'auth:poll' from ${connectionId}. Auth now happens at connection.`);
          // Optionally send back a message indicating successful connection-time auth
          ws.send(JSON.stringify({ type: 'auth:status', authenticated: true, userId: ws.userId }));
        } 
        // Handle tool result messages
        else if (parsedMessage.type === 'toolResult') {
          // Forward to the main Next.js app which has access to ActiveStreamManager
          console.log(`[WebSocket Manager] Received toolResult. Forwarding to main app.`);
          
          // Forward tool result to the API endpoint
          try {
            const { requestId, toolCallId, output } = parsedMessage as ToolResultMessage;
            
            // Make an HTTP request to the tool-result endpoint
            fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/void/tool-result`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userId}` // Use the userId as the auth token
              },
              body: JSON.stringify({
                requestId, 
                toolCallId, 
                output
              })
            })
            .then(res => {
              if (!res.ok) {
                console.error(`[WebSocket Manager] Error forwarding tool result: ${res.status} ${res.statusText}`);
              }
            })
            .catch(err => {
              console.error(`[WebSocket Manager] Failed to forward tool result:`, err);
            });
            
            console.log(`Tool result for ${requestId}/${toolCallId} forwarded to API`);
          } catch (err) {
            console.error('Error forwarding tool result:', err);
          }
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

