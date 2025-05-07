import { Server /*, IncomingMessage - no longer used */ } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from '@clerk/backend';
import { geminiWebSocketService } from '../src/lib/gemini-ws-handler/GeminiWebSocketService'; // Import the new service

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

// Store connections mapped by connectionId, including authenticated userId and state
interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  connectionId: string; // Ensure connectionId is part of the type
  isAuthenticated: boolean;
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

// Client to Server Auth Message
export interface ClientAuthInitiateMessage {
  type: 'auth.initiate';
  token: string;
}

// Server to Client Auth Messages
export interface ServerAuthSuccessMessage {
  type: 'auth.success';
  userId: string;
  connectionId: string;
}

export interface ServerAuthFailureMessage {
  type: 'auth.failure';
  error: string;
}

// General event structure for client communication
export interface BaseClientEvent {
  type: string;
  requestId?: string; // requestId is now optional, as not all server-to-client events have it (e.g. auth responses)
}

export interface GeminiStartEvent extends BaseClientEvent { type: 'geminiStart'; requestId: string; } // Ensure requestId is mandatory here
export interface GeminiContentEvent extends BaseClientEvent { type: 'geminiContent'; chunk: string; requestId: string; }
export interface GeminiDoneEvent extends BaseClientEvent { type: 'geminiDone'; requestId: string; }
export interface GeminiErrorEvent extends BaseClientEvent { type: 'geminiError'; error: string; message?: string; [key: string]: unknown; requestId: string; }
export interface ExecuteToolClientEvent extends BaseClientEvent, ExecuteToolMessage { type: 'executeTool'; requestId: string; }

export type ClientEvent =
  | GeminiStartEvent
  | GeminiContentEvent
  | ExecuteToolClientEvent // This now correctly includes all fields from ExecuteToolMessage
  | GeminiDoneEvent
  | GeminiErrorEvent
  | ServerAuthSuccessMessage // Added for typing consistency if needed by a generic sender
  | ServerAuthFailureMessage; // Added for typing consistency

// Exported function to send auth success message via WebSocket (DEPRECATED by new flow, but kept for now if used elsewhere)
export function sendAuthSuccess(connectionId: string, token: string, userData: UserData) {
  const ws = connections.get(connectionId);
  console.log(`Attempting to send auth success to ${connectionId}`);
  if (ws) {
    ws.send(JSON.stringify({
      type: 'auth:success', // Old type, consider updating if this function is reused
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
  const event: ExecuteToolClientEvent = {
    ...toolExecutionRequest,
    type: 'executeTool',
    requestId: toolExecutionRequest.requestId
  };
  return sendEventToClient(userId, event);
}

/**
 * Sends a generic event to all WebSocket connections for a given user.
 * TODO: Consider if this should target specific connectionId for stream events.
 */
export function sendEventToClient(userId: string, event: ClientEvent): boolean {
  let sent = false;
  const requestIdLog = 'requestId' in event && event.requestId ? event.requestId : 'N/A';
  console.log(`[WebSocket Manager] Attempting to send event type ${event.type} for requestId ${requestIdLog} to user ${userId}`);
  for (const [connId, ws] of connections.entries()) {
    if (ws.userId === userId && ws.isAuthenticated) { // Only send to authenticated connections of the user
      try {
        ws.send(JSON.stringify(event));
        console.log(`[WebSocket Manager] Sent event ${event.type} to connection ${connId} for user ${userId}`);
        sent = true;
      } catch (error) {
        console.error(`[WebSocket Manager] Error sending event ${event.type} to ${connId}:`, error);
      }
    }
  }
  if (!sent) {
    console.warn(`[WebSocket Manager] No active authenticated WebSocket connections found for user ${userId} to send event ${event.type}`);
  }
  return sent;
}

/**
 * Sends an event to a specific WebSocket connection.
 */
export function sendEventToConnection(connectionId: string, event: ClientEvent): boolean {
  const ws = connections.get(connectionId);
  if (ws && ws.isAuthenticated) {
    try {
      ws.send(JSON.stringify(event));
      console.log(`[WebSocket Manager] Sent event ${event.type} to specific connection ${connectionId}`);
      return true;
    } catch (error) {
      console.error(`[WebSocket Manager] Error sending event ${event.type} to ${connectionId}:`, error);
      return false;
    }
  } else {
    console.warn(`[WebSocket Manager] Connection ${connectionId} not found or not authenticated for event ${event.type}`);
    return false;
  }
}

/**
 * Initializes the WebSocket server, attaching it to the provided HTTP server.
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
    // verifyClient is removed; auth happens post-connection
  });
  console.log("WebSocket server initialized. Setting up event listeners...");

  wss.on('connection', (ws: AuthenticatedWebSocket /* req: IncomingMessage - no longer used */) => {
    // Assign a connection ID immediately
    ws.connectionId = Math.random().toString(36).substring(2, 15);
    ws.isAuthenticated = false; // Initialize as not authenticated
    ws.userId = undefined; // Ensure userId is not set initially

    // Temporarily store the potentially unauthenticated connection to handle the auth message
    // This is a simplified approach; a more robust system might use a separate map for pending connections.
    connections.set(ws.connectionId, ws);
    console.log(`[WebSocket Manager] Connection attempt received. ID: ${ws.connectionId}. Awaiting auth.`);

    // Prepare and log the exact message string before sending
		const messageToSend = { type: 'connection.established', connectionId: ws.connectionId };
		const messageString = JSON.stringify(messageToSend);
		console.log(`[WebSocket Manager] Preparing to send to client ${ws.connectionId}: ${messageString}`);
		ws.send(messageString);
		console.log(`[WebSocket Manager] Sent connectionId ${ws.connectionId} to client after logging.`);

    ws.on('message', async (message) => {
      let parsedMessage;
      try {
        parsedMessage = JSON.parse(message.toString());
      } catch (error) {
        console.error(`[WebSocket Manager] Error parsing message from ${ws.connectionId}:`, error);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message' }));
        return;
      }

      console.log(`[WebSocket Manager] Msg type ${parsedMessage.type} from ${ws.connectionId}`);

      if (!ws.isAuthenticated) {
        if (parsedMessage.type === 'auth.initiate') {
          const authMessage = parsedMessage as ClientAuthInitiateMessage;
          try {
            const claims = await verifyToken(authMessage.token, {
              secretKey: process.env.CLERK_SECRET_KEY,
            });
            if (!claims.sub) {
              throw new Error('Invalid token claims (no sub)');
            }
            ws.userId = claims.sub;
            ws.isAuthenticated = true;
            // Update the connection in the map now that it's authenticated
            connections.set(ws.connectionId, ws); 

            const successMessage: ServerAuthSuccessMessage = {
              type: 'auth.success',
              userId: ws.userId,
              connectionId: ws.connectionId
            };
            ws.send(JSON.stringify(successMessage));
            console.log(`[WebSocket Manager] Authentication successful for ${ws.connectionId}, user ${ws.userId}`);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[WebSocket Manager] Authentication failed for ${ws.connectionId}: ${errorMessage}`);
            const failureMessage: ServerAuthFailureMessage = {
              type: 'auth.failure',
              error: `Authentication failed: ${errorMessage}`
            };
            ws.send(JSON.stringify(failureMessage));
            ws.terminate(); // Close connection on auth failure
            connections.delete(ws.connectionId); // Clean up
          }
        } else {
          console.warn(`[WebSocket Manager] Received message type ${parsedMessage.type} from unauthenticated connection ${ws.connectionId}. Closing connection.`);
          ws.send(JSON.stringify({ type: 'error', message: 'Authentication required. Please send auth.initiate message first.' }));
          ws.terminate();
          connections.delete(ws.connectionId); // Clean up
        }
        return; // Do not process further messages if not authenticated or if it was an auth attempt
      }

      // Handle authenticated messages
      if (!ws.userId) {
        console.error(`[WebSocket Manager] Authenticated connection ${ws.connectionId} has no userId. This should not happen.`);
        ws.send(JSON.stringify({ type: 'error', message: 'Internal server error: User ID missing on authenticated connection.' }));
        return;
      }

      switch (parsedMessage.type) {
        case 'gemini.startStream':
          // Directly use the imported singleton instance
          geminiWebSocketService.initiateStream({
            userId: ws.userId,
            connectionId: ws.connectionId,
            requestId: parsedMessage.requestId,
            ...parsedMessage.params,
          });
          break;
        case 'gemini.sendToolResult':
          geminiWebSocketService.handleToolResult({
            userId: ws.userId,
            connectionId: ws.connectionId,
            requestId: parsedMessage.requestId,
            toolCallId: parsedMessage.toolCallId,
            output: parsedMessage.output,
          });
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        default:
          console.warn(`[WebSocket Manager] Unknown message type from ${ws.connectionId}: ${parsedMessage.type}`);
          ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${parsedMessage.type}` }));
      }
    });

    ws.on('close', () => {
      console.log(`[WebSocket Manager] Connection closed: ${ws.connectionId}`);
      // activeStreamManager.cleanupConnection(ws.connectionId); // Method does not exist
      connections.delete(ws.connectionId);
    });

    ws.on('error', (error) => {
      console.error(`[WebSocket Manager] Connection error for ${ws.connectionId}:`, error);
      // Consider cleaning up and removing the connection here as well if not handled by 'close'
    });
  });

  console.log("WebSocket server event listeners configured.");
}

// Make sure activeStreamManager is imported if not already
// import { activeStreamManager } from '../src/lib/streams/ActiveStreamManager';

