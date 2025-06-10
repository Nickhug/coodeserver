import express from 'express';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import { config, validateConfig } from './config';
import logger from '@repo/logger';
import { initClerk, verifyToken, getDbUserByClerkId, getClerkUserData } from '@repo/auth';
import { 
  MessageType, 
  ClientMessage, 
  ServerMessage,
  CodebaseDeleteVectorsRequestMessage,
  CodebaseDeleteVectorsResponseMessage
} from '@repo/types';
import { deleteVectors as pineconeDeleteVectors } from './pinecone-service';
import * as documentProcessingService from './document-processing-service';
import * as gemini from '@repo/ai-providers';
import {
  getUserByClerkId,
  verifyAndConsumeAuthToken,
  storeAuthToken,
  logUsage,
  type AuthTokenVerificationResult,
  type AuthTokenVerificationError
} from '@repo/db';
import { LLMResponse } from '@repo/ai-providers';

/**
 * WebSocket connection data
 */
interface WebSocketConnectionData {
  connectionId: string;
  userId?: string;
  isAuthenticated: boolean;
  lastPingTime: number;
}

/**
 * Type for WebSocket with user data
 */
interface WebSocketWithData extends WebSocket {
  connectionData: WebSocketConnectionData;
}

/**
 * Conversation context for multi-turn tool usage
 */
interface TurnContext {
  provider: string;
  model: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  systemMessage?: string;
  tools?: any[];
  stream: boolean;
  lastPrompt: string;
  messages: any[]; // Store conversation history
  createdAt: number; // Timestamp for cleanup
}

// Store active connections
const connections = new Map<string, WebSocketConnectionData>();

// Store WebSocket server reference for API routes
let globalWss: WebSocketServer;

// Store active conversation contexts for multi-turn tool usage
const activeTurnContexts = new Map<string, TurnContext>();

// Set up a cleanup interval for stale turn contexts (30 minutes timeout)
const TURN_CONTEXT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Clean up stale turn contexts every 5 minutes
setInterval(() => {
  const now = Date.now();
  let expiredCount = 0;

  for (const [requestId, context] of activeTurnContexts.entries()) {
    if (now - context.createdAt > TURN_CONTEXT_TIMEOUT_MS) {
      activeTurnContexts.delete(requestId);
      expiredCount++;
    }
  }

  if (expiredCount > 0) {
    logger.info(`Cleaned up ${expiredCount} stale turn contexts, ${activeTurnContexts.size} remaining active.`);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

/**
 * Set up the HTTP server and WebSocket server
 */
export function setupServer(): http.Server {
  // Create Express app
  const app = express();

  // Initialize Clerk client
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  const clerkJwtKey = process.env.CLERK_JWT_KEY;
  const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;

  if (!clerkSecretKey) {
    logger.warn('CLERK_SECRET_KEY environment variable not found. Authentication will not work properly.');
  } else {
    initClerk(clerkSecretKey, clerkJwtKey, clerkPublishableKey);
    logger.info('Clerk client initialized');
  }

  // Configure CORS
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS']
  }));

  // Parse JSON bodies
  app.use(express.json());

  // Log all incoming requests
  app.use((req, res, next) => {
    logger.info(`HTTP Request: ${req.method} ${req.url}`);
    next();
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Create HTTP server
  const server = http.createServer(app);

  logger.info(`Server setup complete. Server ready to handle HTTP requests and WebSockets.`);
  return server;
}

/**
 * Set up the WebSocket server with optimized configuration for streaming
 */
export function setupWebSocketServer(server: http.Server): WebSocketServer {
  // Create WebSocket server with optimized settings for streaming
  const wss = new WebSocketServer({
    server,
    path: config.wsPath,
    // Increase max payload size
    maxPayload: 100 * 1024 * 1024, // 100MB max payload
    // Enable permessage-deflate for better streaming performance
    perMessageDeflate: {
      zlibDeflateOptions: {
        chunkSize: 1024,
        memLevel: 7,
        level: 3
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024
      },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      concurrencyLimit: 20, // Increased concurrency for better performance
      threshold: 1024 // Only compress messages larger than 1KB
    }
  });

  // Store global reference
  globalWss = wss;

  // Log server configuration
  logger.info(`WebSocket server configured with optimized settings for streaming`);
  logger.info(`WebSocket permessage-deflate compression enabled with threshold: 1024 bytes`);

  // Track WebSocket server stats
  let totalConnections = 0;
  let peakConcurrentConnections = 0;
  const clientVersions = new Map<string, number>();

  // Server-wide connection monitoring
  wss.on('connection', () => {
    totalConnections++;
    const concurrentConnections = wss.clients.size;
    if (concurrentConnections > peakConcurrentConnections) {
      peakConcurrentConnections = concurrentConnections;
    }

    // Log connection stats periodically (every 10 connections)
    if (totalConnections % 10 === 0) {
      logger.info(
        `WS SERVER STATS: Total connections: ${totalConnections}, ` +
        `Current: ${concurrentConnections}, Peak: ${peakConcurrentConnections}`
      );
    }
  });

  // Set up ping interval for connection keepalive
  const pingInterval = global.setInterval(() => {
    const now = Date.now();

    wss.clients.forEach((ws) => {
      const wsWithData = ws as WebSocketWithData;

      if (!wsWithData.connectionData) {
        return;
      }

      const timeSinceLastPing = now - wsWithData.connectionData.lastPingTime;

      // Use a longer timeout (3x ping interval) to avoid premature disconnections
      if (timeSinceLastPing > config.pingInterval * 3) {
        logger.warn(`WS TIMEOUT [${wsWithData.connectionData.connectionId}] Connection timed out after ${timeSinceLastPing}ms, closing`);
        ws.terminate();
        connections.delete(wsWithData.connectionData.connectionId);
        return;
      }

      // Send native WebSocket ping
      try {
        ws.ping();

        // For older clients that don't handle native pings well, also send an application-level ping
        if (timeSinceLastPing > config.pingInterval * 1.5) {
          sendToClient(wsWithData, {
            type: MessageType.PONG, // Send PONG proactively
            payload: {
              serverTime: new Date().toISOString(),
              timestamp: Date.now()
            }
          });
        }
      } catch (error) {
        logger.error(`WS ERROR [${wsWithData.connectionData.connectionId}] Error sending ping: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }, config.pingInterval);

  // Log server metrics every 5 minutes
  const metricsInterval = global.setInterval(() => {
    logger.info(
      `WS SERVER METRICS: Active connections: ${wss.clients.size}, ` +
      `Total historical: ${totalConnections}, Peak concurrent: ${peakConcurrentConnections}`
    );
  }, 5 * 60 * 1000);

  // Clean up intervals if the server is stopped
  wss.on('close', () => {
    logger.info('WebSocket server closing, cleaning up intervals');
    clearInterval(pingInterval);
    clearInterval(metricsInterval);
  });

  // Handle connection events
  wss.on('connection', handleConnection);

  return wss;
}

/**
 * Handle new WebSocket connection
 */
function handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
  // Extract connection info
  const connectionId = uuidv4();
  let userId: string | undefined = undefined;
  let isAuthenticated = false;

  // Log connection attempt with details
  const ip = req.headers['x-forwarded-for'] ||
             req.socket.remoteAddress ||
             'unknown';

  const userAgent = req.headers['user-agent'] || 'unknown';
  logger.info(`WS CONNECT [${connectionId}] New connection from ${ip}, UA: ${userAgent}`);

  // Log all headers for debugging
  logger.debug(`WS CONNECT [${connectionId}] Request headers: ${JSON.stringify(req.headers, null, 2)}`);

  // Add connection data to WebSocket
  (ws as WebSocketWithData).connectionData = {
    connectionId,
    userId,
    isAuthenticated,
    lastPingTime: Date.now()
  };

  // Store connection
  connections.set(connectionId, (ws as WebSocketWithData).connectionData);

  // Log connection established
  logger.info(`WS OPEN [${connectionId}] WebSocket connection established`);

  // Handle error events - add detailed logging
  ws.on('error', (error) => {
    logger.error(`WS ERROR [${connectionId}] ${error.message}`, {
      stack: error.stack,
      code: (error as any).code
    });
  });

  // Handle close events - add detailed logging
  ws.on('close', (code, reason) => {
    logger.info(`WS CLOSE [${connectionId}] ${reason ? ` Code: ${code}, Reason: ${reason.toString()}` : ` Code: ${code}, Reason: `}`);
    // Remove from connections
    connections.delete(connectionId);
  });

  // Respond immediately with a welcome message to test the connection
  try {
    sendToClient(ws as WebSocketWithData, {
      type: MessageType.CONNECT_SUCCESS,
      payload: {
        status: 'connected',
        connectionId,
        timestamp: Date.now()
      }
    });
    logger.info(`WS WELCOME [${connectionId}] Sent welcome message`);
  } catch (error) {
    logger.error(`WS ERROR [${connectionId}] Failed to send welcome message: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      await handleIncomingMessage(ws as WebSocketWithData, message.toString());
    } catch (error) {
      logger.error(`WS ERROR [${connectionId}] Error handling message: ${error instanceof Error ? error.message : String(error)}`);

      // Send error back to client
      try {
        sendToClient(ws as WebSocketWithData, {
          type: MessageType.ERROR,
          payload: {
            error: error instanceof Error ? error.message : String(error),
            timestamp: Date.now()
          }
        });
      } catch (sendError) {
        logger.error(`WS ERROR [${connectionId}] Failed to send error message: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
      }
    }
  });

  // Native ping/pong handlers for better connection stability
  ws.on('ping', (data) => {
    logger.debug(`WS PING [${connectionId}] Received ping`);
    (ws as WebSocketWithData).connectionData.lastPingTime = Date.now();
  });

  ws.on('pong', (data) => {
    logger.debug(`WS PONG [${connectionId}] Received pong`);
    (ws as WebSocketWithData).connectionData.lastPingTime = Date.now();
  });
}

/**
 * Handle incoming WebSocket message
 */
async function handleIncomingMessage(ws: WebSocketWithData, message: string): Promise<void> {
  const { connectionId, userId, isAuthenticated } = ws.connectionData;

  try {
    // Parse message
    const clientMessage = JSON.parse(message) as ClientMessage;

    // Update last ping time for all message types
    ws.connectionData.lastPingTime = Date.now();
    connections.set(connectionId, ws.connectionData);

    // Get the message type as string for safer comparison
    const messageType = clientMessage.type as string;
    const requestId = clientMessage.payload?.requestId || 'no-request-id';

    // Log based on message type
    if (messageType === MessageType.PING) {
      logger.debug(`WS MSG [${connectionId}] Ping received`);
      // Immediately respond with PONG to keep connection alive
      sendToClient(ws, {
        type: MessageType.PONG,
        payload: {
          timestamp: Date.now(),
          serverTime: new Date().toISOString(),
          connectionId: connectionId // Echo back the connection ID for verification
        }
      });
    } else if (messageType === MessageType.AUTHENTICATE) {
      logger.info(`WS MSG [${connectionId}] Authentication request`);
      await handleAuthentication(ws, clientMessage);
    } else if (messageType === MessageType.PROVIDER_LIST) {
      logger.info(`WS MSG [${connectionId}] Provider list request`);
      await handleProviderList(ws);
    } else if (messageType === MessageType.PROVIDER_MODELS) {
      logger.info(`WS MSG [${connectionId}] Provider models request`);
      await handleProviderModels(ws, clientMessage);
    } else if (messageType === MessageType.USER_DATA_REQUEST) {
      logger.info(`WS MSG [${connectionId}][${requestId}] User data request`);
      await handleUserDataRequest(ws, clientMessage);
    } else if (messageType === MessageType.PROVIDER_REQUEST) {
      const provider = clientMessage.payload?.provider || 'unknown';
      const model = clientMessage.payload?.model || 'unknown';
      logger.info(`WS MSG [${connectionId}][${requestId}] Provider request: ${provider}/${model}, streaming: ${!!clientMessage.payload?.stream}`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized provider request rejected`);
        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
            error: 'Authentication required',
            code: 'UNAUTHORIZED',
            requestId: clientMessage.payload?.requestId
          }
        });
        return;
      }
      await handleProviderRequest(ws, clientMessage);
    } else if (messageType === MessageType.TOOL_EXECUTION_RESULT) {
      const toolName = clientMessage.payload?.toolName || 'unknown';
      const toolId = clientMessage.payload?.toolCallId || 'unknown';
      logger.info(`WS MSG [${connectionId}][${requestId}] Tool execution result: ${toolName}, id: ${toolId}, error: ${!!clientMessage.payload?.isError}`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized tool execution result rejected`);
        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
            error: 'Authentication required',
            code: 'UNAUTHORIZED',
            requestId: clientMessage.payload?.requestId
          }
        });
        return;
      }
      await handleToolExecutionResult(ws, clientMessage);
    } else if (messageType === MessageType.CODEBASE_EMBEDDING_REQUEST) {
      logger.info(`WS MSG [${connectionId}][${requestId}] Codebase embedding request`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized embedding request rejected`);
        sendToClient(ws, {
          type: MessageType.ERROR,
          payload: {
            error: 'Authentication required',
            code: 'UNAUTHORIZED',
            requestId: clientMessage.payload?.requestId
          }
        });
        return;
      }
      await handleCodebaseEmbeddingRequest(ws, clientMessage);
    } else if (messageType === MessageType.CODEBASE_EMBEDDING_BATCH_REQUEST) {
      const chunkCount = clientMessage.payload?.chunks?.length || 0;
      logger.info(`WS MSG [${connectionId}][${requestId}] Codebase embedding batch request for ${chunkCount} chunks`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized batch embedding request rejected`);
        sendToClient(ws, {
          type: MessageType.ERROR,
          payload: {
            error: 'Authentication required',
            code: 'UNAUTHORIZED',
            requestId: clientMessage.payload?.requestId
          }
        });
        return;
      }
      await handleCodebaseEmbeddingBatchRequest(ws, clientMessage);
    } else if (messageType === MessageType.CODEBASE_SEARCH_REQUEST) {
      logger.info(`WS MSG [${connectionId}][${requestId}] Codebase search request`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized codebase search request rejected`);
        sendToClient(ws, {
          type: MessageType.ERROR,
          payload: {
            error: 'Authentication required',
            code: 'UNAUTHORIZED',
            requestId: clientMessage.payload?.requestId
          }
        });
        return;
      }
      await handleCodebaseSearchRequest(ws, clientMessage);
    } else if (messageType === MessageType.CODEBASE_CLEAR_INDEX_REQUEST) {
      logger.info(`WS MSG [${connectionId}][${requestId}] Codebase clear index request`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized clear index request rejected`);
        sendToClient(ws, {
          type: MessageType.ERROR,
          payload: {
            error: 'Authentication required',
            code: 'UNAUTHORIZED',
            requestId: clientMessage.payload?.requestId
          }
        } as ServerMessage);
        return;
      }
      await handleCodebaseClearIndexRequest(ws, clientMessage);
    } else if (messageType === MessageType.CODEBASE_DELETE_VECTORS_REQUEST) {
      logger.info(`WS MSG [${connectionId}][${requestId}] Codebase delete vectors request`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized codebase delete vectors request rejected`);
        sendToClient(ws, {
          type: MessageType.CODEBASE_DELETE_VECTORS_RESPONSE, 
          payload: {
            requestId: clientMessage.payload?.requestId,
            success: false,
            error: 'Authentication required',
            code: 'UNAUTHORIZED' // Added for consistency, though not in original plan
          }
        } as CodebaseDeleteVectorsResponseMessage);
        return;
      }

      const deleteRequest = clientMessage as CodebaseDeleteVectorsRequestMessage;
      const { workspaceId, chunkIds } = deleteRequest.payload;

      if (!workspaceId || !chunkIds || chunkIds.length === 0) {
        logger.warn(`WS MSG [${connectionId}][${requestId}] Invalid payload for delete vectors request: workspaceId or chunkIds missing.`);
        sendToClient(ws, {
          type: MessageType.CODEBASE_DELETE_VECTORS_RESPONSE,
          payload: {
            requestId: deleteRequest.payload.requestId,
            success: false,
            error: 'Invalid payload: workspaceId and chunkIds are required.'
          }
        } as CodebaseDeleteVectorsResponseMessage);
        return;
      }

      try {
        await pineconeDeleteVectors(workspaceId, chunkIds);
        logger.info(`WS MSG [${connectionId}][${requestId}] Successfully processed delete vectors request for workspace ${workspaceId}, ${chunkIds.length} chunks.`);
        sendToClient(ws, {
          type: MessageType.CODEBASE_DELETE_VECTORS_RESPONSE,
          payload: {
            requestId: deleteRequest.payload.requestId,
            success: true,
          }
        } as CodebaseDeleteVectorsResponseMessage);
      } catch (error) {
        logger.error(`WS ERROR [${connectionId}][${requestId}] Error deleting vectors for workspace ${workspaceId}:`, error);
        sendToClient(ws, {
          type: MessageType.CODEBASE_DELETE_VECTORS_RESPONSE,
          payload: {
            requestId: deleteRequest.payload.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete vectors'
          }
        } as CodebaseDeleteVectorsResponseMessage);
      }

    } else if (messageType === MessageType.INDEX_DOCUMENT) {
      logger.info(`WS MSG [${connectionId}][${requestId}] Document indexing request`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized document indexing request rejected`);
        sendToClient(ws, {
          type: MessageType.ERROR,
          payload: {
            error: 'Authentication required',
            code: 'UNAUTHORIZED',
            requestId: clientMessage.payload?.requestId
          }
        });
        return;
      }
      
      // Ensure we have a userId before proceeding
      if (!userId) {
        logger.warn(`WS AUTH [${connectionId}] Document indexing request missing userId`);
        sendToClient(ws, {
          type: MessageType.DOCUMENT_INDEX_ERROR,
          payload: {
            error: 'User identification required',
            code: 'UNAUTHORIZED'
          }
        });
        return;
      }
      
      await handleIndexDocument(ws, userId, clientMessage);
    } else if (messageType === MessageType.REMOVE_DOCUMENT) {
      logger.info(`WS MSG [${connectionId}][${requestId}] Document removal request`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized document removal request rejected`);
        sendToClient(ws, {
          type: MessageType.ERROR,
          payload: {
            error: 'Authentication required',
            code: 'UNAUTHORIZED',
            requestId: clientMessage.payload?.requestId
          }
        });
        return;
      }
      
      // Ensure we have a userId before proceeding
      if (!userId) {
        logger.warn(`WS AUTH [${connectionId}] Document removal request missing userId`);
        sendToClient(ws, {
          type: MessageType.DOCUMENT_REMOVE_ERROR,
          payload: {
            error: 'User identification required',
            code: 'UNAUTHORIZED'
          }
        });
        return;
      }
      
      await handleRemoveDocument(ws, userId, clientMessage);
    } else {
      logger.warn(`WS MSG [${connectionId}] Unknown message type: ${messageType}`);
      sendToClient(ws, {
        type: MessageType.ERROR,
        payload: {
          error: `Unknown message type: ${messageType}`,
          code: 'UNKNOWN_MESSAGE_TYPE'
        }
      });
    }
  } catch (error) {
    logger.error(`WS ERROR [${connectionId}] Error processing message: ${error instanceof Error ? error.message : String(error)}`, error);
    // Log a preview of the problematic message
    const messagePreview = message.length > 100 ? `${message.substring(0, 100)}...` : message;
    logger.debug(`WS ERROR [${connectionId}] Problematic message preview: ${messagePreview}`);

    sendToClient(ws, {
      type: MessageType.ERROR,
      payload: {
        error: 'Failed to process message',
        code: 'INTERNAL_ERROR'
      }
    });
  }
}

/**
 * Send message to client with optimizations for streaming
 */
function sendToClient(ws: WebSocketWithData, message: ServerMessage): void {
  try {
    const messageText = JSON.stringify({
      ...message,
      timestamp: Date.now()
    });

    // Debug logging for all messages
    const { connectionId = 'unknown' } = ws.connectionData || {};
    const messageType = message.type;
    const requestId = (message.payload as any)?.requestId || 'no-request-id';

    // For PROVIDER_STREAM_END, add extra logging of toolCall if present
    if (messageType === MessageType.PROVIDER_STREAM_END && (message.payload as any)?.toolCall) {
      const toolCall = (message.payload as any).toolCall;
      const waitingForToolCall = (message.payload as any).waitingForToolCall;

      logger.info(
        `WS SEND TOOL CALL [${connectionId}][${requestId}] ` +
        `Tool call in payload: name=${toolCall.name}, ` +
        `parameters=${JSON.stringify(toolCall.parameters)}, ` +
        `id=${toolCall.id}, ` +
        `waitingForToolCall=${waitingForToolCall}`
      );
    }

    // Log message being sent with different detail levels based on type
    if (messageType === MessageType.PROVIDER_STREAM_CHUNK) {
      const chunk = (message.payload as any)?.chunk || '';
      const provider = (message.payload as any)?.provider || 'unknown';
      const model = (message.payload as any)?.model || 'unknown';
      // Log chunks with truncated content to avoid flooding logs
      const chunkPreview = chunk.length > 50 ? `${chunk.substring(0, 50)}...` : chunk;
      logger.debug(
        `WS SEND [${connectionId}][${requestId}] Stream chunk for ${provider}/${model}, ` +
        `length: ${chunk.length}, preview: "${chunkPreview}"`
      );
    } else if (messageType === MessageType.PROVIDER_STREAM_START) {
      const provider = (message.payload as any)?.provider || 'unknown';
      const model = (message.payload as any)?.model || 'unknown';
      logger.info(
        `WS SEND [${connectionId}][${requestId}] Stream start for ${provider}/${model}`
      );
    } else if (messageType === MessageType.PROVIDER_STREAM_END) {
      const provider = (message.payload as any)?.provider || 'unknown';
      const model = (message.payload as any)?.model || 'unknown';
      const tokensUsed = (message.payload as any)?.tokensUsed || 0;
      logger.info(
        `WS SEND [${connectionId}][${requestId}] Stream end for ${provider}/${model}, ` +
        `tokens: ${tokensUsed}, success: ${(message.payload as any)?.success}`
      );
    } else if (messageType === MessageType.PROVIDER_ERROR || messageType === MessageType.ERROR) {
      // Log errors with full details
      logger.warn(
        `WS SEND [${connectionId}][${requestId}] Error message: ${JSON.stringify(message.payload)}`
      );
    } else {
      // Basic logging for other message types
      logger.debug(`WS SEND [${connectionId}] Message type: ${messageType}`);
    }

    // Send the message, checking for state
    if (ws.readyState === WebSocket.OPEN) {
      // Log WebSocket state before sending
      logger.debug(`WS STATE [${connectionId}] Before send: ${ws.readyState} (OPEN)`);

      // Special handling for Gemini stream chunks to prevent WebSocket overload
      if (message.type === MessageType.PROVIDER_STREAM_CHUNK) {
        // For Gemini models, add a small delay to avoid overwhelming the connection
        // This helps with Gemini 2.5 models which can have premature stream closure issues
        if ((message.payload as any)?.provider === 'gemini' ||
            (message.payload as any)?.model?.includes('gemini')) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(messageText);
                logger.debug(
                  `WS SENT-DELAYED [${connectionId}][${requestId}] ` +
                  `Gemini chunk sent after delay, length: ${messageText.length}`
                );
              } catch (err) {
                logger.error(
                  `WS ERROR [${connectionId}][${requestId}] ` +
                  `Failed to send delayed chunk: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            } else {
              logger.warn(
                `WS DROPPED [${connectionId}][${requestId}] ` +
                `Cannot send delayed chunk, socket state: ${ws.readyState}`
              );
            }
          }, 5);
        } else {
          ws.send(messageText);
          logger.debug(`WS SENT [${connectionId}] ${messageType} sent, length: ${messageText.length}`);
        }
      } else {
        // For non-stream chunks, send immediately
        ws.send(messageText);
        logger.debug(`WS SENT [${connectionId}] ${messageType} sent, length: ${messageText.length}`);
      }
    } else {
      // Log details when message can't be sent
      const stateMap = {
        0: 'CONNECTING',
        1: 'OPEN',
        2: 'CLOSING',
        3: 'CLOSED'
      };
      const stateStr = stateMap[ws.readyState as keyof typeof stateMap] || ws.readyState;

      logger.warn(
        `WS DROPPED [${connectionId}][${requestId}] ` +
        `Cannot send ${messageType}, WebSocket state: ${stateStr}`
      );
    }
  } catch (error) {
    // Enhanced error logging
    const { connectionId = 'unknown' } = ws.connectionData || {};
    logger.error(
      `WS ERROR [${connectionId}] Send failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Track document indexing progress for WebSocket connections
 */
const documentIndexingProgress = new Map<string, Map<string, documentProcessingService.IndexingProgress>>();

/**
 * Send document indexing progress updates to client
 */
function sendDocumentProgress(ws: WebSocketWithData, progress: documentProcessingService.IndexingProgress) {
  try {
    // Get or create a map for this connection
    if (!documentIndexingProgress.has(ws.connectionData.connectionId)) {
      documentIndexingProgress.set(ws.connectionData.connectionId, new Map());
    }

    const progressMap = documentIndexingProgress.get(ws.connectionData.connectionId)!;
    
    // Store latest progress
    progressMap.set(progress.url, progress);

    // Send progress update to client
    sendToClient(ws, {
      type: MessageType.DOCUMENT_INDEXING_PROGRESS,
      payload: progress
    });

    // If complete or error, remove from progress tracking
    if (progress.status === documentProcessingService.IndexingStatus.Complete || 
        progress.status === documentProcessingService.IndexingStatus.Error) {
      progressMap.delete(progress.url);
    }
  } catch (error) {
    logger.error('Error handling document progress:', error);
  }
}

/**
 * Handle document indexing request
 */
async function handleIndexDocument(ws: WebSocketWithData, userId: string, message: ClientMessage) {
  if (!message.payload?.url) {
    sendToClient(ws, {
      type: MessageType.DOCUMENT_INDEX_ERROR,
      payload: {
        error: 'Missing URL',
        url: message.payload?.url || ''
      }
    });
    return;
  }

  const url = message.payload.url;

  try {
    // Set up progress callback to report status to client
    const progressCallback = (progress: documentProcessingService.IndexingProgress) => {
      sendDocumentProgress(ws, progress);
    };

    logger.info(`Starting document indexing for ${url} by user ${userId}`);

    // Start indexing process (non-blocking)
    documentProcessingService.indexDocument(userId, url, progressCallback)
      .then((document) => {
        // Send success message when complete
        sendToClient(ws, {
          type: MessageType.DOCUMENT_INDEXED,
          payload: {
            id: document.id,
            title: document.title,
            url: document.url,
            chunkCount: document.chunks,
            indexedAt: document.timestamp
          }
        });
        logger.info(`Document indexed successfully: ${url}`);
      })
      .catch((error) => {
        // Send error message if indexing fails
        sendToClient(ws, {
          type: MessageType.DOCUMENT_INDEX_ERROR,
          payload: {
            error: error.message || 'Unknown error during indexing',
            url
          }
        });
        logger.error(`Error indexing document ${url}:`, error);
      });

  } catch (error) {
    sendToClient(ws, {
      type: MessageType.DOCUMENT_INDEX_ERROR,
      payload: {
        error: (error as Error).message || 'Unknown error',
        url
      }
    });
    logger.error(`Error handling document indexing for ${url}:`, error);
  }
}

/**
 * Handle document removal request
 */
async function handleRemoveDocument(ws: WebSocketWithData, userId: string, message: ClientMessage) {
  if (!message.payload?.id) {
    sendToClient(ws, {
      type: MessageType.DOCUMENT_REMOVE_ERROR,
      payload: {
        error: 'Missing document ID',
        id: message.payload?.id || ''
      }
    });
    return;
  }

  const documentId = message.payload.id;

  try {
    await documentProcessingService.removeDocument(userId, documentId);
    
    // Send confirmation
    sendToClient(ws, {
      type: MessageType.DOCUMENT_REMOVED,
      payload: { id: documentId }
    });
    
    logger.info(`Document ${documentId} removed for user ${userId}`);
  } catch (error) {
    sendToClient(ws, {
      type: MessageType.DOCUMENT_REMOVE_ERROR,
      payload: {
        error: (error as Error).message || 'Unknown error',
        id: documentId
      }
    });
    logger.error(`Error removing document ${documentId}:`, error);
  }
}

/**
 * Set up HTTP routes
 */
export function setupHttpRoutes(server: http.Server): void {
  // Get the Express application from the server
  const app = server instanceof http.Server ? server.listeners('request')[0] as express.Application : undefined;

  if (!app) {
    logger.error('Cannot set up HTTP routes: Server not properly configured');
    return;
  }

  // Add basic CORS middleware directly to this router to ensure it applies
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS']
  }));

  // Parse JSON body
  app.use(express.json());

  // Log all incoming requests for debugging
  app.use((req, res, next) => {
    logger.info(`HTTP ${req.method} ${req.path}`);
    next();
  });

  // Debug endpoint to test API is up
  app.get('/api/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      connections: connections.size
    });
  });

  // Debug endpoint to list active connections (for debugging)
  app.get('/api/debug/connections', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Not available in production' });
    }

    const connectionsList = Array.from(connections.entries()).map(([id, data]) => ({
      id,
      isAuthenticated: data.isAuthenticated,
      userId: data.userId || null,
      lastPingTime: new Date(data.lastPingTime).toISOString()
    }));

    res.status(200).json({ connections: connectionsList });
  });

  // Handle authentication from web app - this links web auth to WebSocket connections
  app.post('/api/auth', async (req, res) => {
    logger.info('Received auth request to /api/auth');
    try {
      const { connectionId, token, userData } = req.body;

      logger.info(`Auth request for connection: ${connectionId}`);

      if (!connectionId || !token) {
        logger.warn('Missing required params: connectionId or token');
        return res.status(400).json({
          success: false,
          message: 'Missing required parameters'
        });
      }

      // Find WebSocket connection by ID
      const connectionData = connections.get(connectionId);
      if (!connectionData) {
        logger.warn(`Auth API: Connection ${connectionId} not found`);
        // List all active connections for debugging
        const activeConnections = Array.from(connections.keys());
        logger.info(`Active connections: ${activeConnections.join(', ') || 'none'}`);

        return res.status(404).json({
          success: false,
          message: 'Connection not found'
        });
      }

      // Find WebSocket instance
      let wsInstance: WebSocketWithData | undefined;
      for (const client of Array.from(globalWss.clients)) {
        const wsWithData = client as WebSocketWithData;
        if (wsWithData.connectionData?.connectionId === connectionId) {
          wsInstance = wsWithData;
          break;
        }
      }

      if (!wsInstance) {
        logger.warn(`Auth API: WebSocket instance for connection ${connectionId} not found`);
        return res.status(404).json({
          success: false,
          message: 'WebSocket instance not found'
        });
      }

      // Send auth success message that includes the token
      logger.info(`Auth API: Setting authentication for connection ${connectionId}`);
      sendToClient(wsInstance, {
        type: MessageType.AUTH_SUCCESS,
        payload: {
          userId: userData.id,
          connectionId,
          user: userData,
          token: token, // Include the token in the response
          serverTime: new Date().toISOString()
        }
      });

      // Update connection data
      wsInstance.connectionData.userId = userData.id;
      wsInstance.connectionData.isAuthenticated = true;
      connections.set(connectionId, wsInstance.connectionData);

      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('Auth API error:', error);
      return res.status(500).json({
        success: false,
        message: 'Server error processing authentication'
      });
    }
  });

  // Global 404 handler
  app.use((req, res) => {
    logger.warn(`404 Not Found: ${req.method} ${req.path}`);
    res.status(404).send({ success: false, message: 'Not Found' });
  });

  logger.info('HTTP routes configured');
}

/**
 * Start the WebSocket server
 */
export function startWebSocketServer(): http.Server {
  // Validate configuration first
  const configValidation = validateConfig();

  logger.info('=== Server Configuration Validation ===');
  logger.info(`Configuration valid: ${configValidation.isValid}`);

  if (configValidation.errors.length > 0) {
    logger.error('Configuration errors:');
    configValidation.errors.forEach((error: string) => logger.error(`  - ${error}`));
  }

  if (configValidation.warnings.length > 0) {
    logger.warn('Configuration warnings:');
    configValidation.warnings.forEach((warning: string) => logger.warn(`  - ${warning}`));
  }

  // Log environment variables for debugging (without exposing full keys)
  logger.info('=== Environment Variables Check ===');
  logger.info(`NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
  logger.info(`PINECONE_API_KEY: ${process.env.PINECONE_API_KEY ? 'SET (' + process.env.PINECONE_API_KEY.length + ' chars)' : 'NOT SET'}`);
  logger.info(`GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'SET (' + process.env.GEMINI_API_KEY.length + ' chars)' : 'NOT SET'}`);
  logger.info(`PINECONE_INDEX_NAME: ${process.env.PINECONE_INDEX_NAME || 'not set (using default)'}`);
  logger.info(`PINECONE_NAMESPACE: ${process.env.PINECONE_NAMESPACE || 'not set (using default)'}`);
  logger.info('=====================================');

  // Set up the HTTP server
  const server = setupServer();

  // Set up HTTP routes
  setupHttpRoutes(server);

  // Set up the WebSocket server
  setupWebSocketServer(server);

  // Log host configuration information
  if (config.host === '::') {
    logger.info('Server configured to listen on dual-stack IPv4/IPv6 (::)');
  } else if (config.host === '0.0.0.0') {
    logger.info('Server configured to listen on IPv4 only (0.0.0.0)');
    logger.info('Using Railway TCP Proxy at wss://gondola.proxy.rlwy.net:28028/ws');
  }

  // Start the server
  server.listen(config.port, config.host, () => {
    logger.info(`WebSocket server listening on ${config.host}:${config.port}`);
    logger.info(`WebSocket path: ${config.wsPath}`);
    logger.info(`Environment: ${config.environment}`);
  });

  return server;
}

/**
 * Handle authentication request
 */
async function handleAuthentication(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.AUTHENTICATE) {
    logger.error('Invalid message type passed to handleAuthentication');
    return;
  }

  try {
    const { connectionId } = ws.connectionData;

    // Extract token from message
    const token = message.payload?.token;

    if (!token) {
      logger.warn(`Authentication failed for ${connectionId}: No token provided`);
      sendToClient(ws, {
        type: MessageType.AUTH_FAILURE,
        payload: {
          error: 'No authentication token provided',
          code: 'NO_TOKEN'
        }
      });
      return;
    }

    // Verify the token
    logger.info(`Authenticating connection ${connectionId} with token`);

    // Use our shared DB package to verify and consume the token
    const verificationResult: AuthTokenVerificationResult = await verifyAndConsumeAuthToken(token);

    // Check if verificationResult is an error (i.e., it's an AuthTokenVerificationError)
    if ('errorCode' in verificationResult) {
      const errorResult = verificationResult as AuthTokenVerificationError; // Type assertion for easier access
      logger.warn(`Authentication failed for ${connectionId}: ${errorResult.errorMessage}`, { 
        code: errorResult.errorCode, 
        details: errorResult.details 
      });
      sendToClient(ws, {
        type: MessageType.AUTH_FAILURE,
        payload: {
          error: errorResult.errorMessage || 'Invalid authentication token',
          code: errorResult.errorCode || 'INVALID_TOKEN',
          message: typeof errorResult.details === 'string' ? errorResult.details : undefined // Pass db error message if it's a string
        }
      });
      return;
    }

    // If we reach here, verificationResult is AuthTokenVerificationSuccess (which has userId)
    const userId = verificationResult.userId;

    // Set connection as authenticated
    ws.connectionData.userId = userId;
    ws.connectionData.isAuthenticated = true;
    connections.set(connectionId, ws.connectionData);

    // Get user data from both Clerk and DB in parallel for efficiency
    const [clerkUserData, dbUser] = await Promise.all([
      getClerkUserData(userId),
      getUserByClerkId(userId)
    ]);

    // Create enhanced user data object to send
    const userData = {
      id: userId,
      // Prefer DB email since it's the system of record, but fall back to Clerk
      email: dbUser?.email || clerkUserData?.email || '',
      // Include credits and subscription from DB
      credits: dbUser?.credits_remaining || 0,
      subscription: dbUser?.subscription_tier || 'free',
      // Include rich data from Clerk
      name: clerkUserData?.name || '',
      firstName: clerkUserData?.firstName || '',
      lastName: clerkUserData?.lastName || '',
      username: clerkUserData?.username || '',
      avatarUrl: clerkUserData?.avatarUrl || ''
    };

    // Send authentication success message
    logger.info(`Authentication successful for connection ${connectionId} for user ${userId}`);
    sendToClient(ws, {
      type: MessageType.AUTH_SUCCESS,
      payload: {
        userId,
        connectionId,
        user: userData,
        token: token, // Include the token in the response
        serverTime: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Error during authentication:', error);
    sendToClient(ws, {
      type: MessageType.AUTH_FAILURE,
      payload: {
        error: 'Authentication failed',
        code: 'AUTH_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      }
    });
  }
}

/**
 * Handle provider list request
 */
async function handleProviderList(ws: WebSocketWithData): Promise<void> {
  try {
    // Determine available providers based on API keys
    const providers = [
      {
        id: 'gemini',
        name: 'Google Gemini',
        available: Boolean(config.geminiApiKey),
      },
      {
        id: 'openai',
        name: 'OpenAI',
        available: Boolean(config.openaiApiKey),
      },
      {
        id: 'groq',
        name: 'Groq',
        available: Boolean(config.groqApiKey),
      },
      {
        id: 'mistral',
        name: 'Mistral',
        available: Boolean(config.mistralApiKey),
      }
    ];

    // Send provider list
    sendToClient(ws, {
      type: MessageType.PROVIDER_LIST,
      payload: {
        providers,
        defaultProvider: config.defaultProvider
      }
    });
  } catch (error) {
    logger.error('Error getting provider list:', error);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        error: 'Failed to get provider list',
        code: 'PROVIDER_LIST_ERROR'
      }
    });
  }
}

/**
 * Handle provider models request
 */
async function handleProviderModels(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.PROVIDER_MODELS) {
    logger.error('Invalid message type passed to handleProviderModels');
    return;
  }

  const { provider } = message.payload;

  try {
    let models: any[] = [];
    let available = false;

    // Get models for the requested provider
    switch (provider) {
      case 'gemini':
        if (config.geminiApiKey) {
          available = true;
          models = [
            {
              id: 'gemini-2.5-flash-preview-04-17',
              name: 'Gemini 2.5 Flash Preview',
              provider: 'gemini',
              available: true,
              contextWindow: 1048576,
              maxOutputTokens: 65536,
              features: ['chat', 'tools', 'structured-output', 'caching', 'code-execution', 'search-grounding', 'thinking']
            },
            {
              id: 'gemini-2.5-pro-preview-05-06',
              name: 'Gemini 2.5 Pro Preview',
              provider: 'gemini',
              available: true,
              contextWindow: 2097152,
              maxOutputTokens: 65536,
              features: ['chat', 'tools', 'structured-output', 'caching', 'code-execution', 'search-grounding', 'thinking']
            },
            {
              id: 'gemini-2.0-flash',
              name: 'Gemini 2.0 Flash',
              provider: 'gemini',
              available: true,
              contextWindow: 128000,
              maxOutputTokens: 8192,
              features: ['chat', 'tools', 'thinking']
            }
          ];
        }
        break;

      case 'openai':
        if (config.openaiApiKey) {
          available = true;
          models = [
            {
              id: 'gpt-4o',
              name: 'GPT-4o',
              provider: 'openai',
              available: true,
              contextWindow: 128000,
              maxOutputTokens: 4096,
              features: ['streaming', 'toolCalls']
            },
            {
              id: 'gpt-4-turbo',
              name: 'GPT-4 Turbo',
              provider: 'openai',
              available: true,
              contextWindow: 128000,
              maxOutputTokens: 4096,
              features: ['streaming', 'toolCalls']
            },
            {
              id: 'gpt-3.5-turbo',
              name: 'GPT-3.5 Turbo',
              provider: 'openai',
              available: true,
              contextWindow: 16385,
              maxOutputTokens: 4096,
              features: ['streaming', 'toolCalls']
            }
          ];
        }
        break;

      case 'groq':
        if (config.groqApiKey) {
          available = true;
          models = [
            {
              id: 'llama3-8b-8192',
              name: 'Llama-3 8B',
              provider: 'groq',
              available: true,
              contextWindow: 8192,
              maxOutputTokens: 4096,
              features: ['streaming']
            },
            {
              id: 'llama3-70b-8192',
              name: 'Llama-3 70B',
              provider: 'groq',
              available: true,
              contextWindow: 8192,
              maxOutputTokens: 4096,
              features: ['streaming']
            },
            {
              id: 'mixtral-8x7b-32768',
              name: 'Mixtral 8x7B',
              provider: 'groq',
              available: true,
              contextWindow: 32768,
              maxOutputTokens: 4096,
              features: ['streaming']
            }
          ];
        }
        break;

      case 'mistral':
        if (config.mistralApiKey) {
          available = true;
          models = [
            {
              id: 'mistral-large-latest',
              name: 'Mistral Large',
              provider: 'mistral',
              available: true,
              contextWindow: 32768,
              maxOutputTokens: 8192,
              features: ['streaming', 'toolCalls']
            },
            {
              id: 'mistral-medium-latest',
              name: 'Mistral Medium',
              provider: 'mistral',
              available: true,
              contextWindow: 32768,
              maxOutputTokens: 8192,
              features: ['streaming']
            },
            {
              id: 'mistral-small-latest',
              name: 'Mistral Small',
              provider: 'mistral',
              available: true,
              contextWindow: 32768,
              maxOutputTokens: 4096,
              features: ['streaming']
            }
          ];
        }
        break;

      default:
        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
            error: `Unknown provider: ${provider}`,
            code: 'UNKNOWN_PROVIDER'
          }
        });
        return;
    }

    // Send model list
    sendToClient(ws, {
      type: MessageType.PROVIDER_MODELS,
      payload: {
        provider,
        available,
        models
      }
    });
  } catch (error) {
    logger.error(`Error getting models for provider ${provider}:`, error);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        error: `Failed to get models for provider ${provider}`,
        code: 'PROVIDER_MODELS_ERROR'
      }
    });
  }
}

/**
 * Handle provider request from client
 */
async function handleProviderRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.PROVIDER_REQUEST) {
    logger.error('Invalid message type passed to handleProviderRequest');
    return;
  }

  const { provider, model, prompt, temperature, maxTokens, stream = false, requestId, systemMessage, tools } = message.payload;

  // Ensure requestId is always available, generate one if needed
  const safeRequestId = requestId || `gen-${uuidv4().substring(0, 8)}`;

  const userId = ws.connectionData.userId;

  // Log the full request details for debugging
  logger.info(`Provider Request [${safeRequestId}]: ` +
    `Provider: ${provider}, Model: ${model}, User: ${userId || 'anonymous'}, Stream: ${stream}, ` +
    `Prompt Length: ${prompt?.length || 0}, SysMsg Length: ${systemMessage?.length || 0}, ` +
    `Tools: ${tools ? tools.length : 0} (${tools?.map((t: any) => t.name || 'unnamed').join(', ') || 'none'})`);

  if (!userId && config.authEnabled) {
    logger.error(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] No user ID available for provider request`);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        error: 'User ID not available',
        code: 'NO_USER_ID',
        requestId: safeRequestId
      }
    });
    return;
  }

  // Log if system message and tools are present
  if (systemMessage) {
    // No need for redundant logging of systemMessage.length, already in the main request log
    // logger.info(`Request ${safeRequestId} includes system message, length: ${systemMessage.length}`);
  }

  if (tools && Array.isArray(tools) && tools.length > 0) {
    // No need for redundant logging of tool count and names, already in the main request log
    // logger.info(`Request ${safeRequestId} includes ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
    // Remove full tool definitions log
    // logger.info(`FULL TOOLS [${safeRequestId}]: ${JSON.stringify(tools, null, 2)}`);

    // For Gemini, ensure all tool parameters have a 'type' defined, default to 'STRING'
    if (provider === 'gemini') {
      tools.forEach(tool => {
        if (tool.parameters) {
          Object.keys(tool.parameters).forEach(paramName => {
            // @ts-ignore
            if (!tool.parameters[paramName].type) {
              // @ts-ignore
              tool.parameters[paramName].type = 'STRING'; // Default to STRING
            }
          });
        }
      });
      // Remove TOOLS AFTER PROCESSING log, or make it debug level if necessary
      // logger.info(`Processed tools for Gemini, ensuring parameter types for request ${safeRequestId}`);
      logger.debug(`TOOLS AFTER PROCESSING for Gemini [${safeRequestId}]: ${JSON.stringify(tools, null, 2)}`); // Changed to debug
    }
  }

  logger.info(`Processing ${provider} request for model ${model} from user ${userId || 'anonymous'}`);

  try {
    // Check if provider is configured
    let apiKey: string;
    switch (provider) {
      case 'gemini':
        apiKey = config.geminiApiKey;
        break;
      case 'openai':
        apiKey = config.openaiApiKey;
        break;
      case 'groq':
        apiKey = config.groqApiKey;
        break;
      case 'mistral':
        apiKey = config.mistralApiKey;
        break;
      default:
        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
            error: `Unknown provider: ${provider}`,
            code: 'UNKNOWN_PROVIDER',
            requestId: safeRequestId
          }
        });
        return;
    }

    if (!apiKey) {
      sendToClient(ws, {
        type: MessageType.PROVIDER_ERROR,
        payload: {
          error: `Provider ${provider} is not configured`,
          code: 'PROVIDER_NOT_CONFIGURED',
          requestId: safeRequestId
        }
      });
      return;
    }

    // Process based on provider
    if (provider === 'gemini') {
      if (stream) {
        // Handle streaming response using the proper streaming API
        logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Initiating request to model ${model}`);

        try {
          // First, notify client that streaming has started
          sendToClient(ws, {
            type: MessageType.PROVIDER_STREAM_START,
            payload: {
              provider,
              model,
              requestId: safeRequestId
            }
          });

          // Track streaming stats for this request
          const streamStats = {
            startTime: Date.now(),
            chunkCount: 0,
            totalCharsStreamed: 0,
            lastChunkTime: Date.now()
          };

          // Properly initialize chatMode as a valid string value
          const userChatMode = message.payload.chatMode;
          const chatMode: 'normal' | 'gather' | 'agent' =
            userChatMode === 'gather' ? 'gather' :
            userChatMode === 'normal' ? 'normal' : 'agent';

          // Log chat mode and tools for debugging
          logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ChatMode: ${userChatMode} -> ${chatMode}, Tools: ${tools ? tools.map((t: any) => t.name).join(', ') : 'none'}`);

          // Use Gemini's streaming API with proper handlers
          await gemini.streamGeminiMessage({
            apiKey,
            model,
            prompt,
            temperature: temperature || 0.7,
            maxTokens: maxTokens || 50000,
            systemMessage,
            tools,
            chatMode,
            onStart: () => {
              streamStats.startTime = Date.now();
              logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Stream started for model ${model}`);
            },
            onChunk: (chunk: string) => {
              // Update stream stats
              streamStats.chunkCount++;
              streamStats.totalCharsStreamed += chunk.length;
              streamStats.lastChunkTime = Date.now();

              // Log every 10th chunk to avoid log flooding
              if (streamStats.chunkCount % 10 === 0) {
                logger.debug(
                  `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                  `Streaming progress: ${streamStats.chunkCount} chunks, ` +
                  `${streamStats.totalCharsStreamed} chars, ` +
                  `${Date.now() - streamStats.startTime}ms elapsed`
                );
              }

              // Check if the chunk contains any function call syntax that should be parsed out
              // Typical patterns include JSON function call syntax like {"functionCall":{...}} or similar
              if (
                (chunk.includes('antml:function_calls') ||
                 chunk.includes('functionCall') ||
                 chunk.includes('"name":"') ||
                 chunk.includes('"parameters":')) &&
                (chunk.includes('{') && chunk.includes('}'))
              ) {
                // Log potential function call in stream
                logger.warn(
                  `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                  `Function call detected in stream chunk, will be handled properly at stream end. ` +
                  `Length: ${chunk.length}, preview: "${chunk.substring(0, 50)}..."`
                );

                // Instead of skipping this chunk entirely, let's still send the text content
                // but mark that a tool call was detected in the stream
                const cleanedChunk = chunk
                  .replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '')
                  .replace(/```(json)?\s*\{\s*"name"\s*:[\s\S]*?\}\s*```/g, '')
                  .replace(/\{\s*"functionCall"\s*:[\s\S]*?\}/g, '');

                if (cleanedChunk.trim()) {
                  // If there's still content after removing function call syntax, send it
                  sendToClient(ws, {
                    type: MessageType.PROVIDER_STREAM_CHUNK,
                    payload: {
                      chunk: cleanedChunk,
                      requestId: safeRequestId,
                      provider,
                      model
                    }
                  });
                }

                // Don't return early - continue processing stream
                // The function call will be properly extracted in onComplete
              } else {
                // Send regular text chunks to the client as they arrive
                sendToClient(ws, {
                  type: MessageType.PROVIDER_STREAM_CHUNK,
                  payload: {
                    chunk,
                    requestId: safeRequestId,
                    provider,
                    model
                  }
                });
              }
            },
            onError: (error: Error) => {
              logger.error(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Streaming error after ${streamStats.chunkCount} chunks: ${error.message}`
              );

              sendToClient(ws, {
                type: MessageType.PROVIDER_ERROR,
                payload: {
                  error: `Streaming error: ${error.message}`,
                  code: 'STREAMING_ERROR',
                  requestId: safeRequestId,
                  provider,
                  model
                }
              });
            },
            onComplete: async (response: LLMResponse) => {
              // Calculate streaming metrics
              const elapsedMs = Date.now() - streamStats.startTime;
              const charsPerSecond = streamStats.totalCharsStreamed / (elapsedMs / 1000);

              logger.info(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Stream complete: ${streamStats.chunkCount} chunks, ` +
                `${streamStats.totalCharsStreamed} chars, ` +
                `${elapsedMs}ms total time, ` +
                `${charsPerSecond.toFixed(1)} chars/sec, ` +
                `${response.tokensUsed} tokens used`
              );

              // Log full response details for debugging
              logger.info(`Provider Response (Stream) [${safeRequestId}]: ` +
                `Success: ${response.success}, Tokens Used: ${response.tokensUsed}, Text Length: ${response.text?.length || 0}, ` +
                `ToolCall: ${response.toolCall ? response.toolCall.name : 'none'}, WaitingForToolCall: ${!!response.waitingForToolCall}`);

              // Attempt to parse response.text for an error, even if response.success is true
              let apiErrorPayload: any = null;
              if (response.text) {
                try {
                  const parsedText = JSON.parse(response.text);
                  if (parsedText && parsedText.error) {
                    apiErrorPayload = parsedText.error;
                    logger.warn(
                      `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                      `Error found in Gemini response text: ${JSON.stringify(apiErrorPayload)}`
                    );
                  }
                } catch (e) {
                  // Not a JSON error, proceed as normal
                }
              }

              if (apiErrorPayload) {
                sendToClient(ws, {
                  type: MessageType.PROVIDER_ERROR,
                  payload: {
                    error: apiErrorPayload.message || 'Error from Gemini API',
                    code: apiErrorPayload.code || 'GEMINI_API_ERROR',
                    details: apiErrorPayload.details,
                    requestId: safeRequestId,
                    provider,
                    model
                  }
                });
                // Log usage if available, even on API error, as tokens might have been consumed
                if (userId && response.tokensUsed) {
                  logUsage(userId, provider, model, response.tokensUsed);
                }
                return; // Stop further processing
              }

              // Process response to extract and handle any function calls that might be in the text
              // Strip out any remaining function call text from the response
              if (response.text) {
                const cleanedText = response.text
                  .replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '')
                  .replace(/```(json)?\s*\{\s*"name"\s*:[\s\S]*?\}\s*```/g, '')
                  .replace(/\{\s*"functionCall"\s*:[\s\S]*?\}/g, '');

                if (cleanedText !== response.text) {
                  logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Cleaned function call text from response`);
                  response.text = cleanedText.trim();
                }
              }

              // Log tool call information if present
              if (response.toolCall) {
                logger.info(
                  `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                  `Tool call detected in response: ${response.toolCall.name}, ` +
                  `parameters: ${JSON.stringify(response.toolCall.parameters)}`
                );

                // Always ensure waitingForToolCall is true when a tool call is detected
                response.waitingForToolCall = true;

                // Special handling for edit_file tool to ensure searchReplaceBlocks always exists
                if (response.toolCall.name === 'edit_file') {
                  // Ensure that searchReplaceBlocks parameter exists and is a string
                  if (!response.toolCall.parameters.searchReplaceBlocks) {
                    logger.warn(
                      `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                      `edit_file tool missing searchReplaceBlocks parameter, adding empty default`
                    );
                    // If editing an empty file, add an empty searchReplaceBlocks parameter
                    response.toolCall.parameters.searchReplaceBlocks = '';
                  } else if (typeof response.toolCall.parameters.searchReplaceBlocks !== 'string') {
                    logger.warn(
                      `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                      `edit_file tool has non-string searchReplaceBlocks, converting to string`
                    );
                    // Convert to string if it's not already
                    response.toolCall.parameters.searchReplaceBlocks = String(response.toolCall.parameters.searchReplaceBlocks);
                  }
                }

                // Store the conversation context
                activeTurnContexts.set(safeRequestId, {
                  provider,
                  model,
                  apiKey,
                  temperature,
                  maxTokens,
                  systemMessage,
                  tools,
                  stream: true,
                  lastPrompt: String(prompt),
                  messages: [{
                    role: 'user',
                    content: String(prompt)
                  }, {
                    role: 'model',
                    content: response.text || '',
                    toolCalls: [{
                      id: response.toolCall.id || `tool-${Date.now()}`,
                      name: response.toolCall.name,
                      parameters: response.toolCall.parameters
                    }]
                  }],
                  createdAt: Date.now()
                });

                logger.info(
                  `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                  `Stored conversation context for future tool call results`
                );

                // Finalize the stream, directly forwarding the toolCall object
                sendToClient(ws, {
                  type: MessageType.PROVIDER_STREAM_END,
                  payload: {
                    tokensUsed: response.tokensUsed,
                    success: response.success,
                    requestId: safeRequestId,
                    provider,
                    model,
                    toolCall: response.toolCall, // Pass through without transformation
                    waitingForToolCall: true // Always set to true when tool call is present
                  }
                });
              } else {
                logger.info(
                  `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                  `No tool call detected in response`
                );

                // Finalize the stream without tool call
                sendToClient(ws, {
                  type: MessageType.PROVIDER_STREAM_END,
                  payload: {
                    tokensUsed: response.tokensUsed,
                    success: response.success,
                    requestId: safeRequestId,
                    provider,
                    model
                  }
                });
              }

              // Log usage if available
              if (userId && response.tokensUsed) {
                const creditsUsed = response.creditsUsed || (response.tokensUsed / 1000);
                logUsage(userId, provider, model, response.tokensUsed);
              }
            }
          });
        } catch (error) {
          logger.error(
            `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
            `Error in streaming setup: ${error instanceof Error ? error.message : String(error)}`
          );

          sendToClient(ws, {
            type: MessageType.PROVIDER_ERROR,
            payload: {
              error: `Streaming error: ${error instanceof Error ? error.message : String(error)}`,
              code: 'STREAMING_ERROR',
              requestId: safeRequestId
            }
          });
        }
      } else {
        // Handle non-streaming response with improved logging
        const response = await gemini.sendGeminiMessage({
          apiKey,
          model,
          prompt,
          temperature: temperature || 0.7,
          maxTokens: maxTokens || 50000,
          systemMessage,
          tools,
          chatMode: message.payload.chatMode,
        });

        logger.info(`Provider Response (Non-Stream) [${safeRequestId}]: ` +
          `Success: ${response.success}, Tokens Used: ${response.tokensUsed}, Text Length: ${response.text?.length || 0}, ` +
          `ToolCall: ${response.toolCall ? response.toolCall.name : 'none'}, WaitingForToolCall: ${!!response.waitingForToolCall}`);

        // Log tool call information if present
        if (response.toolCall) {
          logger.info(
            `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
            `Tool call detected in response: ${response.toolCall.name}, ` +
            `parameters: ${JSON.stringify(response.toolCall.parameters)}`
          );

          // Store the conversation context
          activeTurnContexts.set(safeRequestId, {
            provider,
            model,
            apiKey,
            temperature,
            maxTokens,
            systemMessage,
            tools,
            stream: false,
            lastPrompt: String(prompt),
            messages: [{
              role: 'user',
              content: String(prompt)
            }, {
              role: 'model',
              content: response.text || '',
              toolCalls: [{
                id: response.toolCall.id || `tool-${Date.now()}`,
                name: response.toolCall.name,
                parameters: response.toolCall.parameters
              }]
            }],
            createdAt: Date.now()
          });

          sendToClient(ws, {
            type: MessageType.PROVIDER_RESPONSE,
            payload: {
              text: response.text,
              tokensUsed: response.tokensUsed,
              success: response.success,
              requestId: safeRequestId,
              toolCall: response.toolCall,
              waitingForToolCall: response.waitingForToolCall
            }
          });
        } else {
          logger.info(
            `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
            `No tool call detected in response`
          );

          sendToClient(ws, {
            type: MessageType.PROVIDER_RESPONSE,
            payload: {
              text: response.text,
              tokensUsed: response.tokensUsed,
              success: response.success,
              requestId: safeRequestId
            }
          });

          // Clean up the context since we're done
          activeTurnContexts.delete(safeRequestId);
        }

        // Log usage
        if (userId && response.tokensUsed) {
          const creditsUsed = response.creditsUsed || (response.tokensUsed / 1000);
          logUsage(userId, provider, model, response.tokensUsed);
        }
      }
    } else {
      // For other providers, we would implement similar logic
      sendToClient(ws, {
        type: MessageType.PROVIDER_ERROR,
        payload: {
          error: `Provider ${provider} is not fully implemented yet`,
          code: 'PROVIDER_NOT_IMPLEMENTED'
        }
      });
    }
  } catch (error) {
    logger.error(`Error processing provider request for ${provider}:`, error);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        error: `Failed to process request for provider ${provider}`,
        code: 'PROVIDER_REQUEST_ERROR'
      }
    });
  }
}

/**
 * Handle user data request from client
 */
async function handleUserDataRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  // Skip type checking since we already checked in the switch statement
  try {
    const { userId } = message.payload;

    // Ensure the requested user ID matches the authenticated user ID (security measure)
    if (userId !== ws.connectionData.userId) {
      logger.warn(`User data request from ${ws.connectionData.userId} for another user ${userId}`);
      sendToClient(ws, {
        type: MessageType.USER_DATA_RESPONSE,
        payload: {
          error: 'Unauthorized to access this user data'
        }
      });
      return;
    }

    // Get user data from both Clerk and DB in parallel for efficiency
    const [clerkUserData, dbUser] = await Promise.all([
      getClerkUserData(userId),
      getUserByClerkId(userId)
    ]);

    if (!dbUser) {
      logger.warn(`User with ID ${userId} not found in database`);
      sendToClient(ws, {
        type: MessageType.USER_DATA_RESPONSE,
        payload: {
          error: 'User not found'
        }
      });
      return;
    }

    // Create enhanced user data object with rich Clerk data
    const userData = {
      id: userId,
      // Prefer DB email since it's the system of record, but fall back to Clerk
      email: dbUser.email || clerkUserData?.email || '',
      // Include credits and subscription from DB
      credits: dbUser.credits_remaining || 0,
      subscription: dbUser.subscription_tier || 'free',
      // Include rich data from Clerk
      name: clerkUserData?.name || '',
      firstName: clerkUserData?.firstName || '',
      lastName: clerkUserData?.lastName || '',
      username: clerkUserData?.username || '',
      avatarUrl: clerkUserData?.avatarUrl || ''
    };

    // Send user data back to client
    logger.info(`Sending user data for ${userId}`);
    sendToClient(ws, {
      type: MessageType.USER_DATA_RESPONSE,
      payload: {
        user: userData
      }
    });
  } catch (error) {
    logger.error('Error handling user data request:', error);
    sendToClient(ws, {
      type: MessageType.USER_DATA_RESPONSE,
      payload: {
        error: 'Error fetching user data'
      }
    });
  }
}

/**
 * Handle tool execution result from client
 */
async function handleToolExecutionResult(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.TOOL_EXECUTION_RESULT) {
    logger.error('Invalid message type passed to handleToolExecutionResult');
    return;
  }

  const { requestId, toolCallId, toolName, result, isError, errorDetails } = message.payload;

  // Ensure we have a valid requestId
  const safeRequestId = requestId || `tool-exec-${uuidv4().substring(0, 8)}`;

  const userId = ws.connectionData.userId;

  // Log the full request details for debugging
  let resultPreview: string;
  if (isError) {
    resultPreview = `Error: ${errorDetails ? String(errorDetails).substring(0, 50) : 'Unknown'}`;
  } else if (typeof result === 'string') {
    resultPreview = `String(len:${result.length})${result.length > 50 ? ", " + result.substring(0, 50) + "..." : ""}`;
  } else if (typeof result === 'object' && result !== null) {
    resultPreview = `Object(keys:${Object.keys(result).join(', ').substring(0,50)})`;
  } else {
    resultPreview = String(result).substring(0,50);
  }

  logger.info(`Tool Execution Result [${safeRequestId}]: ` +
    `ToolName: ${toolName}, ToolCallId: ${toolCallId}, IsError: ${isError}, ResultPreview: ${resultPreview}`);

  if (!userId && config.authEnabled) {
    logger.error(`WS AUTH [${ws.connectionData.connectionId}][${safeRequestId}] No user ID available for tool execution result`);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        error: 'User ID not available',
        code: 'NO_USER_ID',
        requestId: safeRequestId
      }
    });
    return;
  }

  logger.info(`Processing tool execution result for ${toolName} from user ${userId || 'anonymous'}, requestId: ${safeRequestId}`);

  try {
    // Look up the pending conversation context from our request store
    const conversationContext = activeTurnContexts.get(safeRequestId);

    if (!conversationContext) {
      logger.error(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] No active conversation found for tool execution result`);
      sendToClient(ws, {
        type: MessageType.PROVIDER_ERROR,
        payload: {
          error: 'No active conversation found for this tool call',
          code: 'NO_ACTIVE_CONVERSATION',
          requestId: safeRequestId
        }
      });
      return;
    }

    const { provider, model, apiKey, temperature, maxTokens, systemMessage, tools, stream, lastPrompt, messages } = conversationContext;

    // Add tool result to messages
    const toolResponseContent = isError ?
      { error: errorDetails || 'Unknown error during tool execution' } :
      result;

    // Create a proper string representation of the result for the messages array
    const toolResponseString = typeof toolResponseContent === 'string' ?
      toolResponseContent :
      JSON.stringify(toolResponseContent);

    messages.push({
      role: 'tool',
      toolCallId: toolCallId,
      content: toolResponseString
    });

    // Now send the updated conversation back to Gemini
    logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Continuing conversation with tool result for ${toolName}`);

    // Properly initialize chatMode as a valid string value
    const userChatMode = message.payload.chatMode;
    const requestChatMode: 'normal' | 'gather' | 'agent' =
      userChatMode === 'gather' ? 'gather' :
      userChatMode === 'normal' ? 'normal' : 'agent';

    // Process based on whether this is a streaming request
    if (stream) {
      // Send notification that we're continuing the conversation
      sendToClient(ws, {
        type: MessageType.PROVIDER_STREAM_CHUNK,
        payload: {
          chunk: `\n\nProcessing result from ${toolName}...\n\n`,
          requestId: safeRequestId,
          provider,
          model
        }
      });

      try {
        // Setup for streaming
        const streamStats = {
          startTime: Date.now(),
          chunkCount: 0,
          totalCharsStreamed: 0,
          lastChunkTime: Date.now()
        };

        // Continue conversation with Gemini
        await gemini.streamGeminiMessage({
          apiKey,
          model,
          prompt: JSON.stringify(messages),
          temperature: temperature || 0.7,
          maxTokens: maxTokens || 50000,
          systemMessage,
          tools,
          chatMode: requestChatMode,
          onStart: () => {
            streamStats.startTime = Date.now();
            logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Continued stream started for model ${model}`);
          },
          onChunk: (chunk: string) => {
            // Update stream stats
            streamStats.chunkCount++;
            streamStats.totalCharsStreamed += chunk.length;
            streamStats.lastChunkTime = Date.now();

            // Log every 10th chunk to avoid log flooding
            if (streamStats.chunkCount % 10 === 0) {
              logger.debug(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Streaming progress: ${streamStats.chunkCount} chunks, ` +
                `${streamStats.totalCharsStreamed} chars, ` +
                `${Date.now() - streamStats.startTime}ms elapsed`
              );
            }

            // Check if the chunk contains any function call syntax that should be parsed out
            // Typical patterns include JSON function call syntax like {"functionCall":{...}} or similar
            if (
              (chunk.includes('antml:function_calls') ||
               chunk.includes('functionCall') ||
               chunk.includes('"name":"') ||
               chunk.includes('"parameters":')) &&
              (chunk.includes('{') && chunk.includes('}'))
            ) {
              // Log potential function call in stream
              logger.warn(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Function call detected in stream chunk, will be handled properly at stream end. ` +
                `Length: ${chunk.length}, preview: "${chunk.substring(0, 50)}..."`
              );

              // Instead of skipping this chunk entirely, let's still send the text content
              // but mark that a tool call was detected in the stream
              const cleanedChunk = chunk
                .replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '')
                .replace(/```(json)?\s*\{\s*"name"\s*:[\s\S]*?\}\s*```/g, '')
                .replace(/\{\s*"functionCall"\s*:[\s\S]*?\}/g, '');

              if (cleanedChunk.trim()) {
                // If there's still content after removing function call syntax, send it
                sendToClient(ws, {
                  type: MessageType.PROVIDER_STREAM_CHUNK,
                  payload: {
                    chunk: cleanedChunk,
                    requestId: safeRequestId,
                    provider,
                    model
                  }
                });
              }

              // Don't return early - continue processing stream
              // The function call will be properly extracted in onComplete
            } else {
              // Send regular text chunks to the client as they arrive
              sendToClient(ws, {
                type: MessageType.PROVIDER_STREAM_CHUNK,
                payload: {
                  chunk,
                  requestId: safeRequestId,
                  provider,
                  model
                }
              });
            }
          },
          onError: (error: Error) => {
            logger.error(
              `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
              `Streaming error after ${streamStats.chunkCount} chunks: ${error.message}`
            );

            sendToClient(ws, {
              type: MessageType.PROVIDER_ERROR,
              payload: {
                error: `Streaming error: ${error.message}`,
                code: 'STREAMING_ERROR',
                requestId: safeRequestId,
                provider,
                model
              }
            });

            // Clean up the context
            activeTurnContexts.delete(safeRequestId);
          },
          onComplete: (response: LLMResponse) => {
            // Calculate streaming metrics
            const elapsedMs = Date.now() - streamStats.startTime;
            const charsPerSecond = streamStats.totalCharsStreamed / (elapsedMs / 1000);

            logger.info(
              `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
              `Stream complete: ${streamStats.chunkCount} chunks, ` +
              `${streamStats.totalCharsStreamed} chars, ` +
              `${elapsedMs}ms total time, ` +
              `${charsPerSecond.toFixed(1)} chars/sec, ` +
              `${response.tokensUsed} tokens used`
            );

            // Log full response details for debugging
            logger.info(`Provider Response (ToolExec Stream) [${safeRequestId}]: ` +
              `Success: ${response.success}, Tokens Used: ${response.tokensUsed}, Text Length: ${response.text?.length || 0}, ` +
              `ToolCall: ${response.toolCall ? response.toolCall.name : 'none'}, WaitingForToolCall: ${!!response.waitingForToolCall}`);

            // Process response to extract and handle any function calls that might be in the text
            // Strip out any remaining function call text from the response
            if (response.text) {
              const cleanedText = response.text
                .replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '')
                .replace(/```(json)?\s*\{\s*"name"\s*:[\s\S]*?\}\s*```/g, '')
                .replace(/\{\s*"functionCall"\s*:[\s\S]*?\}/g, '');

              if (cleanedText !== response.text) {
                logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Cleaned function call text from response`);
                response.text = cleanedText.trim();
              }
            }

            // Log tool call information if present
            if (response.toolCall) {
              logger.info(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Tool call detected in response: ${response.toolCall.name}, ` +
                `parameters: ${JSON.stringify(response.toolCall.parameters)}`
              );

              // Always ensure waitingForToolCall is true when a tool call is detected
              response.waitingForToolCall = true;

              // Special handling for edit_file tool to ensure searchReplaceBlocks always exists
              if (response.toolCall.name === 'edit_file') {
                // Ensure that searchReplaceBlocks parameter exists and is a string
                if (!response.toolCall.parameters.searchReplaceBlocks) {
                  logger.warn(
                    `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                    `edit_file tool missing searchReplaceBlocks parameter, adding empty default`
                  );
                  // If editing an empty file, add an empty searchReplaceBlocks parameter
                  response.toolCall.parameters.searchReplaceBlocks = '';
                } else if (typeof response.toolCall.parameters.searchReplaceBlocks !== 'string') {
                  logger.warn(
                    `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                    `edit_file tool has non-string searchReplaceBlocks, converting to string`
                  );
                  // Convert to string if it's not already
                  response.toolCall.parameters.searchReplaceBlocks = String(response.toolCall.parameters.searchReplaceBlocks);
                }
              }

              // Store the conversation context
              activeTurnContexts.set(safeRequestId, {
                provider,
                model,
                apiKey,
                temperature,
                maxTokens,
                systemMessage,
                tools,
                stream: true,
                lastPrompt: String(prompt),
                messages: [{
                  role: 'user',
                  content: String(prompt)
                }, {
                  role: 'model',
                  content: response.text || '',
                  toolCalls: [{
                    id: response.toolCall.id || `tool-${Date.now()}`,
                    name: response.toolCall.name,
                    parameters: response.toolCall.parameters
                  }]
                }],
                createdAt: Date.now()
              });

              logger.info(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Stored conversation context for future tool call results`
              );

              // Finalize the stream, directly forwarding the toolCall object
              sendToClient(ws, {
                type: MessageType.PROVIDER_STREAM_END,
                payload: {
                  tokensUsed: response.tokensUsed,
                  success: response.success,
                  requestId: safeRequestId,
                  provider,
                  model,
                  toolCall: response.toolCall, // Pass through without transformation
                  waitingForToolCall: true // Always set to true when tool call is present
                }
              });
            } else {
              logger.info(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `No tool call detected in response`
              );

              // Finalize the stream without tool call
              sendToClient(ws, {
                type: MessageType.PROVIDER_STREAM_END,
                payload: {
                  tokensUsed: response.tokensUsed,
                  success: response.success,
                  requestId: safeRequestId,
                  provider,
                  model
                }
              });
            }
          }
        });
      } catch (error) {
        logger.error(
          `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
          `Error in continued streaming: ${error instanceof Error ? error.message : String(error)}`
        );

        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
            error: `Streaming error: ${error instanceof Error ? error.message : String(error)}`,
            code: 'STREAMING_ERROR',
            requestId: safeRequestId
          }
        });

        // Clean up the context
        activeTurnContexts.delete(safeRequestId);
      }
    } else {
      // Handle non-streaming response with improved logging
      try {
        const response = await gemini.sendGeminiMessage({
          apiKey,
          model,
          prompt: JSON.stringify(messages),
          temperature: temperature || 0.7,
          maxTokens: maxTokens || 50000,
          systemMessage,
          tools,
          chatMode: requestChatMode,
        });

        logger.info(`Provider Response (ToolExec Non-Stream) [${safeRequestId}]: ` +
          `Success: ${response.success}, Tokens Used: ${response.tokensUsed}, Text Length: ${response.text?.length || 0}, ` +
          `ToolCall: ${response.toolCall ? response.toolCall.name : 'none'}, WaitingForToolCall: ${!!response.waitingForToolCall}`);

        // If this is a tool call, update the conversation context and keep it active
        if (response.toolCall) {
          logger.info(
            `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
            `Another tool call detected in non-streaming response: ${response.toolCall.name}, ` +
            `parameters: ${JSON.stringify(response.toolCall.parameters)}`
          );

          // Always ensure waitingForToolCall is true when a tool call is detected
          response.waitingForToolCall = true;

          // Add model's response to messages
          messages.push({
            role: 'model',
            content: response.text || '',
            toolCalls: [{
              id: response.toolCall.id || `tool-${Date.now()}`,
              name: response.toolCall.name,
              parameters: response.toolCall.parameters
            }]
          });

          // Special handling for edit_file tool
          if (response.toolCall.name === 'edit_file') {
            // Ensure that searchReplaceBlocks parameter exists and is a string
            if (!response.toolCall.parameters.searchReplaceBlocks) {
              logger.warn(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Non-streaming edit_file tool missing searchReplaceBlocks parameter, adding empty default`
              );
              response.toolCall.parameters.searchReplaceBlocks = '';
            } else if (typeof response.toolCall.parameters.searchReplaceBlocks !== 'string') {
              logger.warn(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Non-streaming edit_file tool has non-string searchReplaceBlocks, converting to string`
              );
              response.toolCall.parameters.searchReplaceBlocks = String(response.toolCall.parameters.searchReplaceBlocks);
            }
          }

          // Update the conversation context with the latest messages
          conversationContext.messages = messages;
          activeTurnContexts.set(safeRequestId, conversationContext);

          sendToClient(ws, {
            type: MessageType.PROVIDER_RESPONSE,
            payload: {
              text: response.text,
              tokensUsed: response.tokensUsed,
              success: response.success,
              requestId: safeRequestId,
              toolCall: response.toolCall,
              waitingForToolCall: response.waitingForToolCall
            }
          });
        } else {
          // No more tool calls, finalize the conversation
          logger.info(
            `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
            `No further tool calls detected, finishing non-streaming conversation`
          );

          sendToClient(ws, {
            type: MessageType.PROVIDER_RESPONSE,
            payload: {
              text: response.text,
              tokensUsed: response.tokensUsed,
              success: response.success,
              requestId: safeRequestId
            }
          });

          // Clean up the context since we're done
          activeTurnContexts.delete(safeRequestId);
        }

        // Log usage
        if (userId && response.tokensUsed) {
          const creditsUsed = response.creditsUsed || (response.tokensUsed / 1000);
          logUsage(userId, provider, model, response.tokensUsed);
        }
      } catch (error) {
        logger.error(
          `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
          `Error in continued non-streaming request: ${error instanceof Error ? error.message : String(error)}`
        );

        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
            error: `Request error: ${error instanceof Error ? error.message : String(error)}`,
            code: 'PROVIDER_REQUEST_ERROR',
            requestId: safeRequestId
          }
        });

        // Clean up the context due to error
        activeTurnContexts.delete(safeRequestId);
      }
    }
  } catch (error) {
    logger.error(`Error processing tool execution result for ${toolName}:`, error);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        error: `Failed to process tool execution result for ${toolName}`,
        code: 'TOOL_EXECUTION_RESULT_ERROR',
        requestId: safeRequestId
      }
    });

    // Clean up any context due to error
    activeTurnContexts.delete(safeRequestId);
  }
}

/**
 * Handle codebase embedding request
 */
async function handleCodebaseEmbeddingRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.CODEBASE_EMBEDDING_REQUEST) {
    logger.error('Invalid message type passed to handleCodebaseEmbeddingRequest');
    return;
  }

  const { chunk, requestId } = message.payload;
  const userId = ws.connectionData.userId;

  if (!userId) {
    logger.error(`WS EMBEDDING [${ws.connectionData.connectionId}][${requestId}] No user ID available for embedding request`);
    sendToClient(ws, {
      type: MessageType.CODEBASE_EMBEDDING_RESPONSE,
      payload: {
        requestId,
        embedding: [],
        model: config.embeddingModel,
        error: 'User ID not available'
      }
    });
    return;
  }

  logger.info(`Processing embedding request for chunk ${chunk.id} from user ${userId}`);

  try {
    // Import embedding service
    const embeddingService = await import('./embedding-service');

    // Generate embedding
    const result = await embeddingService.generateChunkEmbedding(chunk, userId);

    // Send response
    sendToClient(ws, {
      type: MessageType.CODEBASE_EMBEDDING_RESPONSE,
      payload: {
        requestId,
        embedding: result.embedding,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    // Note: Not logging usage for embedding operations as these are for indexing, not chat
  } catch (error) {
    logger.error(`Error generating embedding for chunk ${chunk.id}:`, error);
    sendToClient(ws, {
      type: MessageType.CODEBASE_EMBEDDING_RESPONSE,
      payload: {
        requestId,
        embedding: [],
        model: config.embeddingModel,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

/**
 * Handle codebase embedding batch request
 */
async function handleCodebaseEmbeddingBatchRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.CODEBASE_EMBEDDING_BATCH_REQUEST) {
    logger.error('Invalid message type passed to handleCodebaseEmbeddingBatchRequest');
    return;
  }

  const { chunks, requestId, batchId } = message.payload;
  const userId = ws.connectionData.userId;

  if (!userId) {
    logger.error(`WS EMBEDDING [${ws.connectionData.connectionId}][${requestId}] No user ID available for batch embedding request`);
    sendToClient(ws, {
      type: MessageType.CODEBASE_EMBEDDING_BATCH_RESPONSE,
      payload: {
        requestId,
        batchId,
        embeddings: [],
        errors: chunks.map((chunk: any) => ({ chunkId: chunk.id, error: 'User ID not available' })),
        tokensUsed: 0,
        successfullyStored: 0
      }
    });
    return;
  }

  logger.info(`Processing batch embedding request for ${chunks.length} chunks from user ${userId}`);

  try {
    // Import embedding service
    const embeddingService = await import('./embedding-service');

    // Track the last time progress was sent to avoid flooding the client
    let lastProgressUpdateTime = 0;
    const PROGRESS_UPDATE_THROTTLE_MS = 20000; // Only send progress updates every 20 seconds
    
    // Generate embeddings with progress tracking
    const result = await embeddingService.generateBatchEmbeddings(chunks, userId, (progress) => {
      const now = Date.now();
      const timeSinceLastUpdate = now - lastProgressUpdateTime;
      
      // Only send progress updates in these cases:
      // 1. Initial update (lastProgressUpdateTime === 0)
      // 2. File-level status changes (started/completed/error)
      // 3. It's been at least PROGRESS_UPDATE_THROTTLE_MS since the last update
      // 4. This is the final update (completedChunks === totalChunks)
      if (
        lastProgressUpdateTime === 0 || 
        progress.fileStatus === 'embedding_started' ||
        progress.fileStatus === 'file_completed' ||
        progress.fileStatus === 'file_error' ||
        timeSinceLastUpdate >= PROGRESS_UPDATE_THROTTLE_MS ||
        progress.completedChunks === progress.totalChunks
      ) {
        // Send progress updates to client
        sendToClient(ws, {
          type: MessageType.CODEBASE_EMBEDDING_PROGRESS,
          payload: {
            requestId,
            batchId,
            completedChunks: progress.completedChunks,
            totalChunks: progress.totalChunks,
            currentBatchNumber: progress.currentBatchNumber,
            totalBatches: progress.totalBatches,
            successfullyStoredInBatch: progress.successfullyStoredInBatch,
            errorsInBatch: progress.errorsInBatch,
            currentFileRelativePath: progress.currentFileRelativePath,
            fileStatus: progress.fileStatus,
            fileErrorDetails: progress.fileErrorDetails,
            // Calculate overall percentage based on chunks for now, client can refine with file counts
            percentage: Math.round((progress.completedChunks / progress.totalChunks) * 100)
          }
        });
        
        lastProgressUpdateTime = now;
      } else {
        // Log that we're throttling updates but don't send to client
        logger.debug(
          `Throttled embedding progress update: ${progress.completedChunks}/${progress.totalChunks} chunks` +
          ` (${Math.round((progress.completedChunks / progress.totalChunks) * 100)}%)` +
          ` - Batch ${progress.currentBatchNumber}/${progress.totalBatches}`
        );
      }
    });

    // Send final response
    sendToClient(ws, {
      type: MessageType.CODEBASE_EMBEDDING_BATCH_RESPONSE,
      payload: {
        requestId,
        batchId,
        embeddings: result.embeddings,
        errors: result.errors,
        tokensUsed: result.totalTokensUsed,
        successfullyStored: result.successfullyStored
      }
    });

    // Note: Not logging usage for embedding operations as these are for indexing, not chat

    logger.info(`Batch embedding completed for user ${userId}: ${result.embeddings.length} successful, ${result.errors.length} errors, ${result.successfullyStored} stored in Pinecone`);

  } catch (error) {
    logger.error(`Error generating batch embeddings:`, error);
    sendToClient(ws, {
      type: MessageType.CODEBASE_EMBEDDING_BATCH_RESPONSE,
      payload: {
        requestId,
        batchId,
        embeddings: [],
        errors: chunks.map((chunk: any) => ({
          chunkId: chunk.id,
          error: error instanceof Error ? error.message : String(error)
        })),
        tokensUsed: 0,
        successfullyStored: 0
      }
    });
  }
}

/**
 * Handle codebase search request
 */
async function handleCodebaseSearchRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.CODEBASE_SEARCH_REQUEST) {
    logger.error('Invalid message type passed to handleCodebaseSearchRequest');
    return;
  }

  const { query, requestId, options, workspaceId } = message.payload;
  const userId = ws.connectionData.userId;

  if (!userId) {
    logger.error(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] No user ID available for search request`);
    sendToClient(ws, {
      type: MessageType.CODEBASE_SEARCH_RESPONSE,
      payload: {
        requestId,
        results: [],
        error: 'User ID not available'
      }
    });
    return;
  }

  try {
    // Handle special stats query
    if (query === "__GET_STATS__") {
      // Use debug level logging for stats requests to avoid excessive logs
      logger.debug(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] Processing stats request for user ${userId}`);
      const pineconeService2 = await import('./pinecone-service');
      const vectorCount = await pineconeService2.getUserVectorCount(userId, workspaceId);
      
      // Log at debug level only
      logger.debug(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] User ${userId} has ${vectorCount} vectors in Pinecone ${workspaceId ? `for workspace ${workspaceId}` : ''}`);

      // Send response with stats
      sendToClient(ws, {
        type: MessageType.CODEBASE_SEARCH_RESPONSE,
        payload: {
          requestId,
          results: [],
          stats: {
            vectorCount,
            namespace: pineconeService2.getUserNamespace(userId, workspaceId)
          }
        }
      });
      return;
    }

    logger.info(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] Processing search request for query: "${query}"`);

    // Import embedding service
    const embeddingService = await import('./embedding-service');

    // Generate embedding for the query
    const queryEmbeddingResult = await embeddingService.generateQueryEmbedding(query, userId);

    if (queryEmbeddingResult.error || !queryEmbeddingResult.embedding || queryEmbeddingResult.embedding.length === 0) {
      logger.error(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] Failed to generate query embedding: ${queryEmbeddingResult.error}`);
      sendToClient(ws, {
        type: MessageType.CODEBASE_SEARCH_RESPONSE,
        payload: {
          requestId,
          results: [],
          error: queryEmbeddingResult.error || 'Failed to generate query embedding'
        }
      });
      return;
    }

    // Import Pinecone service
    const pineconeService = await import('./pinecone-service');

    // Perform hybrid search (vector + keyword) with workspace-specific namespace
    const searchResults = await pineconeService.hybridSearch(
      userId,
      query,
      queryEmbeddingResult.embedding,
      {
        limit: options?.limit || 10,
        filters: options?.filters,
        workspaceId: workspaceId // Pass the workspace ID to use the right namespace
      }
    );

    logger.info(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] Found ${searchResults.length} results`);

    // Send response
    sendToClient(ws, {
      type: MessageType.CODEBASE_SEARCH_RESPONSE,
      payload: {
        requestId,
        results: searchResults
      }
    });

  } catch (error) {
    logger.error(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] Search error:`, error);
    sendToClient(ws, {
      type: MessageType.CODEBASE_SEARCH_RESPONSE,
      payload: {
        requestId,
        results: [],
        error: error instanceof Error ? error.message : 'Search failed'
      }
    });
  }
}

/**
 * Handle codebase clear index request
 */
async function handleCodebaseClearIndexRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.CODEBASE_CLEAR_INDEX_REQUEST) {
    logger.error('Invalid message type passed to handleCodebaseClearIndexRequest');
    return;
  }

  const { requestId, workspaceId } = message.payload;
  const userId = ws.connectionData.userId;

  if (!userId) {
    logger.error(`WS CLEAR_INDEX [${ws.connectionData.connectionId}][${requestId}] No user ID available for clear index request`);
    sendToClient(ws, {
      type: MessageType.CODEBASE_CLEAR_INDEX_RESPONSE,
      payload: {
        requestId,
        success: false,
        error: 'User ID not available',
        workspaceId
      }
    });
    return;
  }

  // Log whether this is workspace-specific or legacy user-level clear request
  if (workspaceId) {
    logger.info(`WS CLEAR_INDEX [${ws.connectionData.connectionId}][${requestId}] Processing workspace-specific clear index request for user ${userId}, workspace ${workspaceId}`);
  } else {
    logger.warn(`WS CLEAR_INDEX [${ws.connectionData.connectionId}][${requestId}] Processing legacy clear index request for user ${userId} without workspace ID`);
  }

  try {
    // Import Pinecone service
    const pineconeService = await import('./pinecone-service');

    // Get current vector count before deletion for reporting
    const vectorCount = await pineconeService.getUserNamespaceStats(userId, workspaceId);

    let deletedCount = 0;
    
    // Check if cleanupInactiveWorkspaces function exists
    if (workspaceId && typeof pineconeService.cleanupInactiveWorkspaces === 'function') {
      // If workspaceId is provided, use it to clean up all OTHER workspaces (inactive ones)
      logger.info(`WS CLEAR_INDEX [${ws.connectionData.connectionId}][${requestId}] Cleaning up inactive workspaces for user ${userId}, keeping only active workspace ${workspaceId}`);
      try {
        deletedCount = await pineconeService.cleanupInactiveWorkspaces(userId, workspaceId);
        logger.info(`WS CLEAR_INDEX [${ws.connectionData.connectionId}][${requestId}] Successfully cleaned up ${deletedCount} vectors from inactive workspaces for user ${userId}`);
      } catch (cleanupError) {
        logger.error(`WS CLEAR_INDEX [${ws.connectionData.connectionId}][${requestId}] Error cleaning up inactive workspaces:`, cleanupError);
      }
    } else {
      // Legacy behavior: just delete the vectors for the specified workspace
      await pineconeService.deleteUserVectors(userId, workspaceId);
      logger.info(`WS CLEAR_INDEX [${ws.connectionData.connectionId}][${requestId}] Successfully cleared ${vectorCount} vectors for user ${userId}${workspaceId ? `, workspace ${workspaceId}` : ''}`);
    }

    sendToClient(ws, {
      type: MessageType.CODEBASE_CLEAR_INDEX_RESPONSE,
      payload: {
        requestId,
        success: true,
        deletedVectorCount: workspaceId ? deletedCount : vectorCount,
        workspaceId,
        cleanedUpInactiveWorkspaces: workspaceId ? true : false
      }
    });

  } catch (error) {
    logger.error(`WS CLEAR_INDEX [${ws.connectionData.connectionId}][${requestId}] Error during clear index:`, error);
    sendToClient(ws, {
      type: MessageType.CODEBASE_CLEAR_INDEX_RESPONSE,
      payload: {
        requestId,
        success: false,
        error: error instanceof Error ? error.message : 'Clear index failed'
      }
    });
  }
}

export default {
  setupServer,
  setupWebSocketServer,
  startWebSocketServer
};
