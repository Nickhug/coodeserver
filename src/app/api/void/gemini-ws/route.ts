import { WebSocket } from 'ws';
import { logger } from '@/lib/logger';
import { activeStreamManager, ToolCall, GeminiMessage } from '@/lib/streams/ActiveStreamManager';
import { sendGeminiRequest } from '@/lib/ai-providers/gemini-provider';
import { checkUserCreditsById } from '@/lib/clerk/auth';

// --- Event Type Definitions ---
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
type ExecuteToolClientEvent = {
  type: 'executeTool';
  requestId: string;
  toolCall: ToolCall;
};

// Union type for all client-bound events (server to client)
type ServerEvent =
  | GeminiStartEvent
  | GeminiContentEvent
  | GeminiErrorEvent
  | GeminiDoneEvent
  | ExecuteToolClientEvent
  | ConnectionEstablishedEvent
  | AuthSuccessEvent
  | AuthFailureEvent;

// Connection state for tracking authentication and user info
interface ConnectionState {
  userId?: string;
  isAuthenticated: boolean;
}

// Map to track connection states by connection ID
const connectionStates = new Map<WebSocket, ConnectionState>();

/**
 * WebSocket handler using next-ws
 */
export function SOCKET(client: WebSocket) {
  logger.info('[GeminiWebSocketService] New connection established');
  
  // Initialize connection with unauthenticated state
  connectionStates.set(client, { isAuthenticated: false });

  // Send connection established event
  sendToClient(client, { type: 'connection.established' });

  // Handle client messages
  client.on('message', async (message) => {
    try {
      const parsedMessage = JSON.parse(message.toString());
      logger.info(`[GeminiWebSocketService] Received message: ${parsedMessage.type}`);

      const connectionState = connectionStates.get(client);
      if (!connectionState) {
        throw new Error('Connection state not found');
      }

      // Handle authentication message
      if (parsedMessage.type === 'auth.initiate') {
        await handleAuthentication(client, connectionState, parsedMessage.token);
        return;
      }

      // For all other message types, require authentication
      if (!connectionState.isAuthenticated || !connectionState.userId) {
        logger.warn(`[GeminiWebSocketService] Unauthenticated request: ${parsedMessage.type}`);
        sendToClient(client, {
          type: 'auth.failure',
          error: 'UnauthenticatedRequest',
          message: 'Authentication required. Send auth.initiate message first.'
        });
        return;
      }

      // Handle authenticated messages
      if (parsedMessage.type === 'gemini.startStream') {
        const { requestId, model, messages, systemMessage, temperature, maxTokens, tools } = parsedMessage.payload;
        await initiateStream(client, connectionState.userId, requestId, model, messages, systemMessage, temperature, maxTokens, tools);
      } else if (parsedMessage.type === 'toolResult') {
        const { requestId, toolCallId, output } = parsedMessage.payload;
        await handleToolResult(client, connectionState.userId, requestId, toolCallId, output);
      } else {
        logger.warn(`[GeminiWebSocketService] Unknown message type: ${parsedMessage.type}`);
        sendToClient(client, {
          type: 'geminiError',
          requestId: 'unknown',
          error: 'UnknownMessageType',
          message: `Unknown message type: ${parsedMessage.type}`
        });
      }
    } catch (error) {
      logger.error('[GeminiWebSocketService] Error processing message:', error);
      sendToClient(client, {
        type: 'geminiError',
        requestId: 'unknown',
        error: 'InvalidMessageFormat',
        message: 'Could not parse incoming message.'
      });
    }
  });

  // Handle disconnection
  client.on('close', () => {
    logger.info('[GeminiWebSocketService] Connection closed');
    
    // Get user ID before removing the connection
    const userId = connectionStates.get(client)?.userId;
    
    // Remove the connection
    connectionStates.delete(client);
    
    // Clean up streams if this connection was authenticated
    if (userId) {
      const removedStreamIds = activeStreamManager.cleanupStreamsForUser(userId);
      logger.info(`[GeminiWebSocketService] Cleaned up ${removedStreamIds.length} streams for user ${userId} on connection close`);
    }
  });

  // Handle errors
  client.on('error', (error) => {
    logger.error('[GeminiWebSocketService] Connection error:', error);
    
    // Get user ID before removing the connection
    const userId = connectionStates.get(client)?.userId;
    
    // Remove the connection
    connectionStates.delete(client);
    
    // Clean up streams if this connection was authenticated
    if (userId) {
      const removedStreamIds = activeStreamManager.cleanupStreamsForUser(userId);
      logger.info(`[GeminiWebSocketService] Cleaned up ${removedStreamIds.length} streams for user ${userId} on connection error`);
    }
  });
}

/**
 * Send event to client
 */
function sendToClient(client: WebSocket, event: ServerEvent) {
  try {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(event));
    } else {
      logger.warn(`[GeminiWebSocketService] Attempted to send to a closed socket for event type: ${event.type}`);
    }
  } catch (error) {
    logger.error(`[GeminiWebSocketService] Error sending event type ${event.type} to client:`, error);
  }
}

/**
 * Handle authentication
 * 
 * Note: In a production environment, you would want to use proper token verification.
 * This implementation uses a simplified approach since WebSockets don't have the HTTP
 * context that Clerk middleware normally uses.
 */
async function handleAuthentication(client: WebSocket, connectionState: ConnectionState, token: string) {
  try {
    if (!token) {
      throw new Error('Authentication token is required');
    }

    logger.info('[GeminiWebSocketService] Processing authentication');
    
    try {
      // In a production environment, you would verify the token
      // For simplicity, we'll accept the token and extract a user ID from it
      
      // This is a placeholder implementation - in production use proper verification
      const userId = token.includes('_') ? token.split('_')[1] : token;
      
      if (!userId) {
        throw new Error('Invalid authentication token');
      }
      
      // Update connection state with authenticated user
      connectionState.userId = userId;
      connectionState.isAuthenticated = true;
      
      logger.info(`[GeminiWebSocketService] Authentication successful for user ${userId}`);
      
      // Send success response
      sendToClient(client, {
        type: 'auth.success',
        userId
      });
    } catch (tokenError) {
      logger.error('[GeminiWebSocketService] Token verification failed:', tokenError);
      sendToClient(client, {
        type: 'auth.failure',
        error: 'InvalidToken',
        message: 'Authentication token verification failed'
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown authentication error';
    logger.error(`[GeminiWebSocketService] Authentication error: ${errorMessage}`);
    sendToClient(client, {
      type: 'auth.failure',
      error: 'AuthenticationError',
      message: errorMessage
    });
  }
}

/**
 * Initiate a Gemini stream
 */
async function initiateStream(
  client: WebSocket,
  userId: string,
  requestId: string,
  model: string,
  messages: GeminiMessage[],
  systemMessage?: string,
  temperature?: number,
  maxTokens?: number,
  tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[]
) {
  try {
    logger.info(`[GeminiWebSocketService] Initiating stream for user ${userId}, requestId ${requestId}`);
    
    // Check if user has sufficient credits to make this request
    const { hasCredits, creditsRemaining } = await checkUserCreditsById(userId);
    
    // Calculate required credits (we'd need to implement logic to determine this)
    const requiredCredits = 1; // Default value, should be calculated based on model
    
    // If user doesn't have enough credits, send an error and return
    if (!hasCredits) {
      logger.warn(`[GeminiWebSocketService] Insufficient credits for user ${userId}`, { creditsRemaining, requiredCredits });
      sendToClient(client, {
        type: 'geminiError',
        requestId,
        error: 'InsufficientCredits',
        message: 'You do not have enough credits to make this request.',
        creditsRemaining,
        requiredCredits
      });
      return;
    }
    
    // Register the stream context with activeStreamManager
    activeStreamManager.register(
      requestId,
      undefined, // No controller for WebSocket streams
      messages,
      userId,
      {
        systemMessage,
        tools,
        model,
        temperature,
        maxTokens
      }
    );
    
    // Send start event to client
    sendToClient(client, { type: 'geminiStart', requestId });
    
    // Get Gemini API key
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }
    
    // Call Gemini API with streaming
    await sendGeminiRequest({
      apiKey,
      model,
      messages,
      systemMessage,
      temperature,
      maxTokens,
      tools,
      onStream: (text, toolCallUpdate) => {
        if (toolCallUpdate) {
          // Track tool call in ActiveStreamManager
          const toolCall: ToolCall = {
            id: toolCallUpdate.id || '',
            name: toolCallUpdate.name,
            parameters: toolCallUpdate.parameters
          };
          
          activeStreamManager.trackToolCall(requestId, toolCall);
          
          logger.info(`[GeminiWebSocketService] Stream ${requestId}: Tool call - ${toolCall.name}`);
          sendToClient(client, {
            type: 'executeTool',
            requestId,
            toolCall
          });
        } else if (text) {
          // Send content chunk to client
          logger.debug(`[GeminiWebSocketService] Stream ${requestId}: Content chunk length ${text.length}`);
          sendToClient(client, {
            type: 'geminiContent',
            requestId,
            chunk: text
          });
        }
      }
    }).then((response) => {
      if (!response.success) {
        logger.error(`[GeminiWebSocketService] Stream ${requestId} Error: ${response.error}`);
        sendToClient(client, {
          type: 'geminiError',
          requestId,
          error: response.error || 'UnknownError',
          message: response.error || 'An unknown error occurred'
        });
      } else if (!response.waitingForToolCall) {
        logger.info(`[GeminiWebSocketService] Stream ${requestId}: Done`);
        sendToClient(client, { type: 'geminiDone', requestId });
        
        // Clean up stream context since it's completed
        activeStreamManager.remove(requestId);
      }
    }).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[GeminiWebSocketService] Stream ${requestId} Unhandled Error: ${errorMessage}`);
      sendToClient(client, {
        type: 'geminiError',
        requestId,
        error: 'StreamError',
        message: errorMessage
      });
      
      // Clean up stream context on error
      activeStreamManager.remove(requestId);
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[GeminiWebSocketService] Error initiating stream ${requestId} for user ${userId}: ${errorMessage}`);
    sendToClient(client, {
      type: 'geminiError',
      requestId,
      error: 'InitiationError',
      message: errorMessage
    });
  }
}

/**
 * Handle tool result and continue the stream
 */
async function handleToolResult(
  client: WebSocket,
  userId: string,
  requestId: string,
  toolCallId: string,
  output: unknown
) {
  try {
    logger.info(`[GeminiWebSocketService] Handling tool result for user ${userId}, stream ${requestId}, toolCallId ${toolCallId}`);
    
    // Validate that this user owns this stream
    if (!activeStreamManager.validateUser(requestId, userId)) {
      logger.warn(`[GeminiWebSocketService] Unauthorized tool result submission for stream ${requestId} by user ${userId}`);
      sendToClient(client, {
        type: 'geminiError',
        requestId,
        error: 'UnauthorizedRequest',
        message: 'You are not authorized to submit tool results for this stream.'
      });
      return;
    }
    
    // Add tool result to message history
    const { success, updatedMessages } = activeStreamManager.addToolResult(requestId, toolCallId, output);
    
    if (!success || !updatedMessages) {
      throw new Error(`Failed to add tool result for tool call ${toolCallId} in stream ${requestId}`);
    }
    
    // Get stream context
    const streamContext = activeStreamManager.get(requestId);
    if (!streamContext) {
      throw new Error(`Stream context not found for ${requestId}`);
    }
    
    // Resume the stream
    activeStreamManager.resumeStream(requestId);
    logger.info(`[GeminiWebSocketService] Resuming stream ${requestId} with tool result.`);
    
    // Get Gemini API key
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }
    
    // Continue the conversation with the added tool result
    await sendGeminiRequest({
      apiKey,
      model: streamContext.model,
      messages: updatedMessages,
      systemMessage: streamContext.systemMessage,
      temperature: streamContext.temperature,
      maxTokens: streamContext.maxTokens,
      tools: streamContext.tools,
      onStream: (text, toolCallUpdate) => {
        if (toolCallUpdate) {
          // Track tool call in ActiveStreamManager
          const toolCall: ToolCall = {
            id: toolCallUpdate.id || '',
            name: toolCallUpdate.name,
            parameters: toolCallUpdate.parameters
          };
          
          activeStreamManager.trackToolCall(requestId, toolCall);
          
          logger.info(`[GeminiWebSocketService] Stream ${requestId} (resumed): Tool call - ${toolCall.name}`);
          sendToClient(client, {
            type: 'executeTool',
            requestId,
            toolCall
          });
        } else if (text) {
          // Send content chunk to client
          logger.debug(`[GeminiWebSocketService] Stream ${requestId} (resumed): Content chunk length ${text.length}`);
          sendToClient(client, {
            type: 'geminiContent',
            requestId,
            chunk: text
          });
        }
      }
    }).then((response) => {
      if (!response.success) {
        logger.error(`[GeminiWebSocketService] Resumed Stream ${requestId} Error: ${response.error}`);
        sendToClient(client, {
          type: 'geminiError',
          requestId,
          error: response.error || 'UnknownError',
          message: response.error || 'An unknown error occurred'
        });
      } else if (!response.waitingForToolCall) {
        logger.info(`[GeminiWebSocketService] Resumed Stream ${requestId}: Done`);
        sendToClient(client, { type: 'geminiDone', requestId });
        
        // Clean up stream context since it's completed
        activeStreamManager.remove(requestId);
      }
    }).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[GeminiWebSocketService] Resumed Stream ${requestId} Unhandled Error: ${errorMessage}`);
      sendToClient(client, {
        type: 'geminiError',
        requestId,
        error: 'StreamError',
        message: errorMessage
      });
      
      // Clean up stream context on error
      activeStreamManager.remove(requestId);
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[GeminiWebSocketService] Error handling tool result for stream ${requestId} (user ${userId}): ${errorMessage}`);
    sendToClient(client, {
      type: 'geminiError',
      requestId,
      error: 'ToolResultError',
      message: errorMessage
    });
  }
} 