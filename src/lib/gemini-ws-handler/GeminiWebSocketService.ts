import { WebSocket, WebSocketServer, RawData } from 'ws';
import { logger } from '../logger';
import { activeStreamManager, ToolCall, GeminiMessage } from '../streams/ActiveStreamManager';
import { sendGeminiRequest } from '../ai-providers/gemini-provider';
import { LLMResponse } from '../ai-providers/providers';
import { checkUserCreditsById } from '../clerk/auth';

// --- BEGIN Event Type Definitions ---
// Client-bound events (server to client)
type GeminiStartEvent = { type: 'geminiStart'; requestId: string };
type GeminiContentEvent = { type: 'geminiContent'; requestId: string; chunk: string };
type GeminiErrorEvent = {
  type: 'geminiError';
  requestId: string;
  error: string;
  message?: string;
  creditsRemaining?: number;
  requiredCredits?: number;
};
type GeminiDoneEvent = { type: 'geminiDone'; requestId: string };
type ConnectionEstablishedEvent = { type: 'connection.established' };
type AuthSuccessEvent = { type: 'auth.success'; userId: string };
type AuthFailureEvent = { type: 'auth.failure'; error: string; message: string };

// Tool execution event (server to client)
export type ExecuteToolClientEvent = {
  type: 'executeTool';
  requestId: string;
  toolCall: ToolCall;
};

// Server-bound events (client to server)
type AuthInitiateClientEvent = { type: 'auth.initiate'; token: string };
type GeminiStartStreamClientEvent = { 
  type: 'gemini.startStream'; 
  payload: Omit<StreamInitiationParams, 'socket' | 'userId'>; 
};
type ToolResultClientEvent = { 
  type: 'toolResult'; 
  payload: Omit<ToolResultParams, 'socket' | 'userId'>; 
};

// Union type for all client-bound events (server to client)
export type ServerEvent =
  | GeminiStartEvent
  | GeminiContentEvent
  | GeminiErrorEvent
  | GeminiDoneEvent
  | ExecuteToolClientEvent
  | ConnectionEstablishedEvent
  | AuthSuccessEvent
  | AuthFailureEvent;

// Union type for all server-bound events (client to server)
export type ClientEvent = 
  | AuthInitiateClientEvent
  | GeminiStartStreamClientEvent
  | ToolResultClientEvent;
// --- END Event Type Definitions ---

// Connection state for tracking authentication and user info
interface ConnectionState {
  socket: WebSocket;
  userId?: string;
  isAuthenticated: boolean;
}

interface StreamInitiationParams {
  userId: string;
  socket: WebSocket;
  requestId: string;
  model: string;
  messages: GeminiMessage[];
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[];
}

interface ToolResultParams {
  userId: string;
  socket: WebSocket;
  requestId: string;
  toolCallId: string;
  output: unknown;
}

export class GeminiWebSocketService {
  private connections: Map<string, ConnectionState>;

  constructor() {
    this.connections = new Map();
    logger.info('[GeminiWebSocketService] Initialized');
  }

  public initialize(wss: WebSocketServer): void {
    logger.info('[GeminiWebSocketService] Initializing WebSocket handlers...');
    wss.on('connection', (socket, req) => {
      const connectionId = req.headers['sec-websocket-key'] as string | undefined;
      
      if (!connectionId) {
        logger.error('[GeminiWebSocketService] Connection attempt without a connection ID (sec-websocket-key). Terminating.');
        socket.terminate();
        return;
      }

      logger.info(`[GeminiWebSocketService] New connection: ${connectionId}`);
      
      // Initialize connection with unauthenticated state
      this.connections.set(connectionId, { 
        socket, 
        isAuthenticated: false 
      });

      // Send connection established event
      this.sendToClient(socket, { type: 'connection.established' } as ServerEvent);

      socket.on('message', (message: RawData) => {
        this.handleClientMessage(socket, connectionId, message);
      });

      socket.on('close', () => {
        logger.info(`[GeminiWebSocketService] Connection closed: ${connectionId}`);
        
        // Get user ID before removing the connection
        const userId = this.connections.get(connectionId)?.userId;
        
        // Remove the connection
        this.connections.delete(connectionId);
        
        // Clean up streams if this connection was authenticated
        if (userId) {
          const removedStreamIds = activeStreamManager.cleanupStreamsForUser(userId);
          logger.info(`[GeminiWebSocketService] Cleaned up ${removedStreamIds.length} streams for user ${userId} on connection close`);
        }
      });

      socket.on('error', (error) => {
        logger.error(`[GeminiWebSocketService] Error on connection ${connectionId}:`, error);
        
        // Get user ID before removing the connection
        const userId = this.connections.get(connectionId)?.userId;
        
        // Remove the connection
        this.connections.delete(connectionId);
        
        // Clean up streams if this connection was authenticated
        if (userId) {
          const removedStreamIds = activeStreamManager.cleanupStreamsForUser(userId);
          logger.info(`[GeminiWebSocketService] Cleaned up ${removedStreamIds.length} streams for user ${userId} on connection error`);
        }
      });
    });
  }

  private async handleClientMessage(socket: WebSocket, connectionId: string, message: RawData) {
    try {
      const parsedMessage = JSON.parse(message.toString());
      logger.info(`[GeminiWebSocketService] Received message from ${connectionId}: ${parsedMessage.type}`);

      const connectionState = this.connections.get(connectionId);
      if (!connectionState) {
        throw new Error(`Connection state not found for ${connectionId}`);
      }

      // Handle authentication message
      if (parsedMessage.type === 'auth.initiate') {
        await this.handleAuthentication(connectionId, connectionState, parsedMessage.token);
        return;
      }

      // For all other message types, require authentication
      if (!connectionState.isAuthenticated || !connectionState.userId) {
        logger.warn(`[GeminiWebSocketService] Unauthenticated request from ${connectionId}: ${parsedMessage.type}`);
        this.sendToClient(socket, {
          type: 'auth.failure',
          error: 'UnauthenticatedRequest',
          message: 'Authentication required. Send auth.initiate message first.'
        } as ServerEvent);
        return;
      }

      // Handle authenticated messages
      if (parsedMessage.type === 'gemini.startStream') {
        const params: Omit<StreamInitiationParams, 'socket' | 'userId'> = parsedMessage.payload;
        await this.initiateStream({ 
          ...params, 
          socket, 
          userId: connectionState.userId 
        });
      } else if (parsedMessage.type === 'toolResult') {
        const params: Omit<ToolResultParams, 'socket' | 'userId'> = parsedMessage.payload;
        await this.handleToolResult({ 
          ...params, 
          socket, 
          userId: connectionState.userId 
        });
      } else {
        logger.warn(`[GeminiWebSocketService] Unknown message type: ${parsedMessage.type}`);
        this.sendToClient(socket, {
          type: 'geminiError',
          requestId: 'unknown',
          error: 'UnknownMessageType',
          message: `Unknown message type: ${parsedMessage.type}`
        } as ServerEvent);
      }

    } catch (error) {
      logger.error(`[GeminiWebSocketService] Error processing message from ${connectionId}:`, error);
      this.sendToClient(socket, {
        type: 'geminiError',
        requestId: 'unknown',
        error: 'InvalidMessageFormat',
        message: 'Could not parse incoming message.'
      } as ServerEvent);
    }
  }

  private async handleAuthentication(connectionId: string, connectionState: ConnectionState, token: string) {
    const { socket } = connectionState;
    
    try {
      if (!token) {
        throw new Error('Authentication token is required');
      }

      logger.info(`[GeminiWebSocketService] Processing authentication for connection ${connectionId}`);
      
      // In a real-world scenario, you'd verify the token with Clerk
      // For now, we'll use a simplified approach that simulates token verification
      
      // Example approach:
      // 1. Parse the token (JWT or session token)
      // 2. Verify its signature and expiration
      // 3. Extract the user ID
      
      // This is a placeholder for the actual token verification logic
      // In production, use proper Clerk SDK methods to verify the token
      
      let userId: string | undefined;
      
      // Check if token is a valid Clerk token
      try {
        // This is a simplified approach. In production, use proper Clerk verification
        // Mock verification for demonstration purposes
        if (token.startsWith('clerk_')) {
          // Simulate token verification success
          // In production, use proper Clerk SDK methods
          userId = token.slice(6); // Just a placeholder
        } else {
          throw new Error('Invalid token format');
        }
      } catch (tokenError) {
        logger.error(`[GeminiWebSocketService] Token verification failed for connection ${connectionId}:`, tokenError);
        this.sendToClient(socket, {
          type: 'auth.failure',
          error: 'InvalidToken',
          message: 'The provided authentication token is invalid or expired.'
        } as ServerEvent);
        return;
      }

      if (!userId) {
        throw new Error('Failed to extract user ID from token');
      }

      // Update connection state with authenticated user
      connectionState.isAuthenticated = true;
      connectionState.userId = userId;
      this.connections.set(connectionId, connectionState);

      logger.info(`[GeminiWebSocketService] Authentication successful for user ${userId} on connection ${connectionId}`);
      
      // Send authentication success response
      this.sendToClient(socket, {
        type: 'auth.success',
        userId: userId
      } as ServerEvent);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[GeminiWebSocketService] Authentication error for connection ${connectionId}: ${errorMessage}`);
      
      this.sendToClient(socket, {
        type: 'auth.failure',
        error: 'AuthenticationError',
        message: errorMessage
      } as ServerEvent);
    }
  }

  private sendToClient(socket: WebSocket, event: ServerEvent) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      } else {
        logger.warn(`[GeminiWebSocketService] Attempted to send to a closed socket for event type: ${event.type}`);
      }
    } catch (error) {
      logger.error(`[GeminiWebSocketService] Error sending event type ${event.type} to client:`, error);
    }
  }

  async initiateStream(params: StreamInitiationParams): Promise<void> {
    const { 
      userId, socket, requestId, model, messages, 
      systemMessage, temperature, maxTokens, tools 
    } = params;

    logger.info(`[GeminiWebSocketService] Initiating stream for user ${userId}, requestId ${requestId}`);

    try {
      if (!userId) throw new Error('User ID is required for stream initiation');
      if (!requestId || !model || !messages) {
        throw new Error('Missing required parameters for stream initiation');
      }

      const textContents = messages.map((m: GeminiMessage) => m.parts.map((part: GeminiMessage['parts'][0]) => part.text || (part.inlineData ? '[IMAGE DATA]' : '')).join(' ')).join(' ');
      const estimatedTokens = Math.ceil(textContents.length / 4) * 2;
      const requiredCredits = estimatedTokens / 1000;

      const { hasCredits, creditsRemaining } = await checkUserCreditsById(userId, requiredCredits);
      if (!hasCredits) {
        logger.warn(`[GeminiWebSocketService] Insufficient credits for user ${userId}`, { creditsRemaining, requiredCredits });
        this.sendToClient(socket, {
          type: 'geminiError',
          requestId,
          error: 'Insufficient credits',
          message: `You do not have enough credits. Required: ${requiredCredits}, Remaining: ${creditsRemaining}`,
          creditsRemaining,
          requiredCredits
        } as ServerEvent);
        return;
      }

      activeStreamManager.register(
        requestId,
        undefined, 
        messages,
        userId,
        { systemMessage, tools, model, temperature, maxTokens }
      );

      this.sendToClient(socket, { type: 'geminiStart', requestId } as ServerEvent);

      sendGeminiRequest({
        apiKey: process.env.GEMINI_API_KEY!,
        model,
        messages,
        systemMessage,
        temperature,
        maxTokens,
        tools,
        onStream: (text: string, toolCallUpdate?: { name: string; parameters: Record<string, unknown>; id?: string }) => {
          if (toolCallUpdate?.id) {
            const toolCall: ToolCall = {
              name: toolCallUpdate.name,
              parameters: { ...(toolCallUpdate.parameters || {}) },
              id: toolCallUpdate.id,
            };
            activeStreamManager.trackToolCall(requestId, toolCall);
            logger.info(`[GeminiWebSocketService] Stream ${requestId}: Tool call - ${toolCall.name}`);
            this.sendToClient(socket, {
              type: 'executeTool',
              requestId,
              toolCall,
            } as ExecuteToolClientEvent);
          }
          if (text) {
            logger.debug(`[GeminiWebSocketService] Stream ${requestId}: Content chunk length ${text.length}`);
            this.sendToClient(socket, {
              type: 'geminiContent',
              requestId,
              chunk: text,
            } as ServerEvent);
          }
        },
      }).then(async (response: LLMResponse) => {
        if (!response.success && response.error) {
          logger.error(`[GeminiWebSocketService] Stream ${requestId} Error: ${response.error}`);
          this.sendToClient(socket, {
            type: 'geminiError',
            requestId,
            error: response.error,
            message: response.error,
          } as ServerEvent);
        } else if (response.success && !response.waitingForToolCall) {
          logger.info(`[GeminiWebSocketService] Stream ${requestId}: Done`);
          this.sendToClient(socket, { type: 'geminiDone', requestId } as ServerEvent);
        }

        const streamContext = activeStreamManager.get(requestId);
        if (streamContext && Object.keys(streamContext.toolCalls).length === 0 && !response.waitingForToolCall) {
          activeStreamManager.remove(requestId);
        }
      }).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[GeminiWebSocketService] Stream ${requestId} Unhandled Error: ${errorMessage}`);
        this.sendToClient(socket, {
          type: 'geminiError',
          requestId,
          error: 'Internal server error',
          message: errorMessage,
        } as ServerEvent);
        activeStreamManager.remove(requestId);
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[GeminiWebSocketService] Error initiating stream ${requestId} for user ${userId}: ${errorMessage}`);
      this.sendToClient(socket, {
        type: 'geminiError',
        requestId,
        error: 'StreamInitiationError',
        message: errorMessage,
      } as ServerEvent);
    }
  }

  async handleToolResult(params: ToolResultParams): Promise<void> {
    const { userId, socket, requestId, toolCallId, output } = params;
    logger.info(`[GeminiWebSocketService] Handling tool result for user ${userId}, stream ${requestId}, toolCallId ${toolCallId}`);

    try {
      if (!userId) throw new Error('User ID is required for tool result handling');
      const streamContext = activeStreamManager.get(requestId);
      if (!streamContext) {
        throw new Error(`Stream with requestId ${requestId} not found.`);
      }
      if (streamContext.userId !== userId) {
        throw new Error(`User ${userId} not authorized for stream ${requestId}.`);
      }

      const { updatedMessages } = activeStreamManager.addToolResult(requestId, toolCallId, output);
      if (!updatedMessages) {
        throw new Error(`Failed to add tool result for toolCallId ${toolCallId} in stream ${requestId}.`);
      }
      
      activeStreamManager.resumeStream(requestId);

      logger.info(`[GeminiWebSocketService] Resuming stream ${requestId} with tool result.`);
      sendGeminiRequest({
        apiKey: process.env.GEMINI_API_KEY!,
        model: streamContext.model,
        messages: updatedMessages,
        systemMessage: streamContext.systemMessage,
        temperature: streamContext.temperature,
        maxTokens: streamContext.maxTokens,
        tools: streamContext.tools,
        onStream: (text: string, toolCallUpdate?: { name: string; parameters: Record<string, unknown>; id?: string }) => {
          if (toolCallUpdate?.id) {
            const toolCall: ToolCall = {
              name: toolCallUpdate.name,
              parameters: { ...(toolCallUpdate.parameters || {}) },
              id: toolCallUpdate.id,
            };
            activeStreamManager.trackToolCall(requestId, toolCall);
            logger.info(`[GeminiWebSocketService] Stream ${requestId} (resumed): Tool call - ${toolCall.name}`);
            this.sendToClient(socket, {
              type: 'executeTool',
              requestId,
              toolCall,
            } as ExecuteToolClientEvent);
          }
          if (text) {
            logger.debug(`[GeminiWebSocketService] Stream ${requestId} (resumed): Content chunk length ${text.length}`);
            this.sendToClient(socket, {
              type: 'geminiContent',
              requestId,
              chunk: text,
            } as ServerEvent);
          }
        },
      }).then(async (response: LLMResponse) => {
        if (!response.success && response.error) {
          logger.error(`[GeminiWebSocketService] Resumed Stream ${requestId} Error: ${response.error}`);
          this.sendToClient(socket, {
            type: 'geminiError',
            requestId,
            error: response.error,
            message: response.error,
          } as ServerEvent);
        } else if (response.success && !response.waitingForToolCall) {
          logger.info(`[GeminiWebSocketService] Resumed Stream ${requestId}: Done`);
          this.sendToClient(socket, { type: 'geminiDone', requestId } as ServerEvent);
        }
        const currentStreamContext = activeStreamManager.get(requestId);
        if (currentStreamContext && Object.keys(currentStreamContext.toolCalls).length === 0 && !response.waitingForToolCall) {
          activeStreamManager.remove(requestId);
        }
      }).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[GeminiWebSocketService] Resumed Stream ${requestId} Unhandled Error: ${errorMessage}`);
        this.sendToClient(socket, {
          type: 'geminiError',
          requestId,
          error: 'Internal server error during resume',
          message: errorMessage,
        } as ServerEvent);
        activeStreamManager.remove(requestId);
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[GeminiWebSocketService] Error handling tool result for stream ${requestId} (user ${userId}): ${errorMessage}`);
      this.sendToClient(socket, {
        type: 'geminiError',
        requestId,
        error: 'ToolResultProcessingError',
        message: errorMessage,
      } as ServerEvent);
    }
  }
} 