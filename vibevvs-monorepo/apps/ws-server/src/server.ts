/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coode AI Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import express from 'express';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import { config, validateConfig } from './config';
import logger from '@repo/logger';
import { initClerk, getDbUserByClerkId, getClerkUserData } from '@repo/auth';
import { 
  MessageType, 
  ClientMessage, 
  ServerMessage,
  CodebaseDeleteVectorsRequestMessage,
  CodebaseDeleteVectorsResponseMessage,
  ChatMessage,
  ToolCall
} from '@repo/types';
import { deleteVectors as pineconeDeleteVectors } from './pinecone-service';
import * as documentProcessingService from './document-processing-service';
import * as gemini from '@repo/ai-providers';
import * as mistral from './mistral';
import type { ToolCall as MistralToolCall } from '@mistralai/mistralai/models/components'; // For Mistral tool calls
import {
  getUserByClerkId,
  verifyAndConsumeAuthToken,
  storeAuthToken,
  logUsage,
  type AuthTokenVerificationResult,
  type AuthTokenVerificationError
} from '@repo/db';
import { LLMResponse } from '@repo/ai-providers';
import { availableTools, chat_systemMessage, InternalToolInfo } from './prompts/prompts.js';
import { convertToolsToGeminiFormat, convertChatMessagesToGeminiFormat } from './toolConverter.js';

/**
 * Defines the structure for the context passed from the client
 * to generate the system prompt.
 */
export interface PromptContext {
  workspaceFolders: string[];
  directoryStr: string;
  openedURIs: string[];
  activeURI: string | undefined;
  persistentTerminalIDs: string[];
  chatMode: 'normal' | 'gather' | 'agent';
  includeXMLToolDefinitions: boolean;
  os: string;
}

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
  parallelToolCalls?: boolean;
  stream: boolean;
  lastPrompt: string;
  messages: ChatMessage[]; // Store conversation history
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
    } else if (messageType === MessageType.FIM_REQUEST) {
      const provider = clientMessage.payload?.provider || 'unknown';
      const model = clientMessage.payload?.model || 'unknown';
      logger.info(`WS MSG [${connectionId}][${requestId}] FIM request: ${provider}/${model}, streaming: ${!!clientMessage.payload?.stream}`);
      if (config.authEnabled && !isAuthenticated) {
        logger.warn(`WS AUTH [${connectionId}] Unauthorized FIM request rejected`);
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
      await handleFimRequest(ws, clientMessage);
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
            requestId: clientMessage.payload.requestId,
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
          type: MessageType.DOCUMENT_INDEX_ERROR,
          payload: {
            error: 'Authentication required',
            code: 'UNAUTHORIZED'
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

      // Send all messages immediately - delays can cause premature termination
      ws.send(messageText);
      logger.debug(`WS SENT [${connectionId}] ${messageType} sent, length: ${messageText.length}`);
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
export function setupHttpRoutes(server: http.Server, wss?: WebSocketServer): void {
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

  // Add FIM streaming endpoint
  app.post('/api/void/llm-message/fim/stream', express.json({ limit: '50mb' }), async (req, res) => {
    const requestId = uuidv4();
    const startTime = Date.now();
    logger.info(`[${requestId}] FIM request received: ${JSON.stringify(req.body?.modelName || 'unknown')}`);
    
    try {
      const {
        prefix,
        suffix,
        modelName = 'codestral-latest',
        stopSequences = [],
        temperature = 0.2,
        maxTokens = 512,
        providerName = 'mistral',
        apiKey,
        stream = true
      } = req.body;

      // Validate request
      if (!prefix && !suffix) {
        logger.error(`[${requestId}] FIM request missing both prefix and suffix`);
        return res.status(400).json({ error: 'Either prefix or suffix must be provided' });
      }

      if (!apiKey) {
        logger.error(`[${requestId}] FIM request missing API key`);
        return res.status(401).json({ error: 'API key is required' });
      }

      // Set headers for streaming response
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
      }

      // Setup to track response data
      let fullText = '';
      let tokenCount = 0;
      let isResponseComplete = false;

      // Setup for client abort handling
      req.on('close', () => {
        if (!isResponseComplete) {
          logger.info(`[${requestId}] Client closed connection before FIM response completion`);
          isResponseComplete = true;
        }
      });

      // Process FIM request
      await mistral.processFIM({
        apiKey,
        prefix,
        suffix,
        model: modelName,
        temperature,
        maxTokens,
        stream,
        stopSequences,
        // Handle streaming chunks
        onStream: (chunk) => {
          if (isResponseComplete) return;
          tokenCount++;

          fullText += chunk;
          
          // Send chunk as SSE
          res.write(`data: ${JSON.stringify({
            event: 'text',
            text: chunk,
            fullText: fullText,
            modelName,
            timeSinceStart: Date.now() - startTime,
            tokenCount,
          })}\n\n`);
        },
        // Handle final completed response
        onFinal: (text) => {
          if (isResponseComplete) return;
          isResponseComplete = true;

          if (stream) {
            // Send final event for streaming responses
            res.write(`data: ${JSON.stringify({
              event: 'end',
              fullText: text || fullText,
              modelName,
              timeSinceStart: Date.now() - startTime,
              tokenCount,
            })}\n\n`);
            res.end();
          } else {
            // Send JSON response for non-streaming requests
            res.json({
              text: text || fullText,
              modelName,
              timeSinceStart: Date.now() - startTime,
              tokenCount,
            });
          }

          logger.info(`[${requestId}] FIM request completed in ${Date.now() - startTime}ms, tokens: ${tokenCount}`);
        },
        // Handle errors
        onError: (error) => {
          if (isResponseComplete) return;
          isResponseComplete = true;

          logger.error(`[${requestId}] FIM request error: ${error.message}`);

          if (stream) {
            res.write(`data: ${JSON.stringify({
              event: 'error',
              error: error.message,
              timeSinceStart: Date.now() - startTime,
            })}\n\n`);
            res.end();
          } else {
            res.status(500).json({
              error: error.message,
              timeSinceStart: Date.now() - startTime,
            });
          }
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[${requestId}] FIM request processing error: ${errorMsg}`);
      
      if (!res.headersSent) {
        res.status(500).json({
          error: errorMsg,
          timeSinceStart: Date.now() - startTime,
        });
      } else {
        try {
          res.write(`data: ${JSON.stringify({
            event: 'error',
            error: errorMsg,
            timeSinceStart: Date.now() - startTime,
          })}\n\n`);
          res.end();
        } catch (writeError) {
          logger.error(`[${requestId}] Failed to send error response: ${String(writeError)}`);
        }
      }
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
  logger.info(`MISTRAL_API_KEY: ${process.env.MISTRAL_API_KEY ? 'SET (' + process.env.MISTRAL_API_KEY.length + ' chars)' : 'NOT SET'}`);
  logger.info(`PINECONE_INDEX_NAME: ${process.env.PINECONE_INDEX_NAME || 'not set (using default)'}`);
  logger.info(`PINECONE_NAMESPACE: ${process.env.PINECONE_NAMESPACE || 'not set (using default)'}`);
  logger.info('=====================================');

  // Set up the HTTP server
  const server = setupServer();

  // Set up the WebSocket server
  const wss = setupWebSocketServer(server);

  // Set up HTTP routes
  setupHttpRoutes(server, wss);

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
    ws.connectionData.isAuthenticated = true;
    ws.connectionData.userId = userId;
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
          models = await gemini.listModels(config.geminiApiKey);
        }
        break;

      case 'openai':
        if (config.openaiApiKey) {
          available = true;
          // TODO: Implement dynamic model listing for OpenAI
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
          // TODO: Implement dynamic model listing for Groq
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
          models = await mistral.listModels(config.mistralApiKey);
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
 * Handle FIM (Fill-in-the-Middle) request from client
 */
async function handleFimRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.FIM_REQUEST) {
    logger.error('Invalid message type passed to handleFimRequest');
    return;
  }

  const { provider, model, fim, temperature, maxTokens, stream = true, requestId } = message.payload;
  const { prefix, suffix, stopTokens } = fim || {}; // Extract from fim object, provide default if fim is undefined

  // Ensure requestId is always available, generate one if needed
  const safeRequestId = requestId || `fim-${uuidv4().substring(0, 8)}`;

  const userId = ws.connectionData.userId;

  // Log the full request details for debugging
  logger.info(`FIM Request [${safeRequestId}]: ` +
    `Provider: ${provider}, Model: ${model}, User: ${userId || 'anonymous'}, Stream: ${stream}, ` +
    `Prefix Length: ${prefix?.length || 0}, Suffix Length: ${suffix?.length || 0}`);

  if (!userId && config.authEnabled) {
    logger.error(`WS FIM [${ws.connectionData.connectionId}][${safeRequestId}] No user ID available for FIM request`);
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

  logger.info(`Processing ${provider} FIM request for model ${model} from user ${userId || 'anonymous'}`);

  try {
    // Check if provider is configured
    let apiKey: string;
    switch (provider) {
      case 'mistral': // Currently only Mistral supported for FIM
        apiKey = config.mistralApiKey;
        break;
      default:
        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
            error: `Provider ${provider} is not supported for FIM requests`,
            code: 'UNSUPPORTED_PROVIDER',
            requestId: safeRequestId
          }
        });
        return;
    }

    if (!apiKey) {
      sendToClient(ws, {
        type: MessageType.PROVIDER_ERROR,
        payload: {
          error: `API key for provider ${provider} is not configured`,
          code: 'MISSING_API_KEY',
          requestId: safeRequestId
        }
      });
      return;
    }

    // Initialize provider client based on provider type
    if (provider === 'mistral') {
      // Signal stream start
      if (stream) {
        sendToClient(ws, {
          type: MessageType.PROVIDER_STREAM_START,
          payload: {
            provider,
            model,
            requestId: safeRequestId
          }
        });
      }

      // Call the correct FIM processor from mistral.ts
      await mistral.processFIM({
        apiKey,
        prefix,
        suffix,
        model,
        temperature: temperature || 0.97,
        maxTokens: maxTokens || 512,
        stream,
        stopSequences: [], // Not yet implemented in client
        
        onStream: (chunk) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            logger.warn(`WS FIM [${ws.connectionData.connectionId}][${safeRequestId}] WebSocket not open, cannot send stream chunk.`);
            return;
          }
          sendToClient(ws, {
            type: MessageType.PROVIDER_STREAM_CHUNK,
            payload: {
              chunk,
              requestId: safeRequestId,
              provider,
              model
            }
          });
        },
        
        onFinal: (fullText, tokensUsed) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            logger.warn(`WS FIM [${ws.connectionData.connectionId}][${safeRequestId}] WebSocket not open, cannot send stream end.`);
            return;
          }
          sendToClient(ws, {
            type: MessageType.PROVIDER_STREAM_END,
            payload: {
              success: true,
              text: fullText,
              tokensUsed: tokensUsed,
              requestId: safeRequestId,
              provider,
              model,
              waitingForToolCall: false
            }
          });
        },
        
        onError: (error: Error) => {
          logger.error(
            `WS FIM [${ws.connectionData.connectionId}][${safeRequestId}] ` +
            `Streaming error after tool: ${error.message}`
          );
        }
      });
    } else {
      // This shouldn't happen as we already filtered unsupported providers
      sendToClient(ws, {
        type: MessageType.PROVIDER_ERROR,
        payload: {
          error: `Provider ${provider} is not fully implemented yet`,
          code: 'PROVIDER_NOT_IMPLEMENTED'
        }
      });
    }
  } catch (error) {
    logger.error(`Error processing FIM request for ${provider}:`, error);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        error: `Failed to process FIM request for ${provider}`,
        code: 'PROVIDER_REQUEST_ERROR'
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

  const { 
    provider, 
    model, 
    prompt, 
    temperature, 
    maxTokens, 
    stream = true, 
    requestId, 
    toolChoice, 
    parallelToolCalls, 
    requestType,
    messages: clientMessages,
    promptContext
  } = message.payload;

  const safeRequestId = requestId || uuidv4();
  const userId = ws.connectionData.userId;

  // Log the full request details for debugging
  logger.info(`Provider Request [${safeRequestId}]: ` +
    `Provider: ${provider}, Model: ${model}, User: ${userId || 'anonymous'}, Stream: ${stream}, ` +
    `Prompt Length: ${prompt?.length || 0}, ` +
    `ToolChoice: ${toolChoice}, ParallelToolCalls: ${parallelToolCalls}, RequestType: ${requestType}`);

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

  // --- SERVER-SIDE PROMPT/TOOL GENERATION ---
  if (!promptContext) {
    logger.error(`WS  [${ws.connectionData.connectionId}][${safeRequestId}] No promptContext provided for provider request`);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        error: 'promptContext is required for provider requests',
        code: 'BAD_REQUEST',
        requestId: safeRequestId
      }
    });
    return;
  }

  const systemMessage = chat_systemMessage(promptContext);
  const tools: InternalToolInfo[] = availableTools(promptContext.chatMode);
  const messages = clientMessages || [{ role: 'user', content: prompt }];

  logger.info(`[${safeRequestId}] Generated system prompt (len: ${systemMessage.length}) and ${tools.length} tools for chatMode: ${promptContext.chatMode}`);
  // --- END ---


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
      const geminiTools = convertToolsToGeminiFormat(tools);
      logger.debug(`TOOLS AFTER PROCESSING for Gemini [${safeRequestId}]: ${JSON.stringify(geminiTools, null, 2)}`);
    }

    // For Mistral, ensure tools are in the correct format
    if (provider === 'mistral') {
      // Mistral will handle tool conversion internally, but let's log what we're sending
      if (tools && tools.length > 0) {
        logger.info(`Passing ${tools.length} tools to Mistral for request ${safeRequestId}`);
        logger.debug(`TOOLS for Mistral [${safeRequestId}]: ${JSON.stringify(tools.map(t => ({name: t.name, description: t.description})), null, 2)}`);
      }
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
            code: 'UNKNOWN_PROVIDER'
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
            lastPingTime: Date.now()
          };

          // Properly initialize chatMode as a valid string value
          const userChatMode = promptContext.chatMode;
          const chatMode: 'normal' | 'gather' | 'agent' =
            userChatMode === 'gather' ? 'gather' :
            userChatMode === 'normal' ? 'normal' : 'agent';

          // Log chat mode and tools for debugging
          logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ChatMode: ${userChatMode} -> ${chatMode}, Tools: ${tools ? tools.map((t: any) => t.name).join(', ') : 'none'}`);

          const geminiTools = convertToolsToGeminiFormat(tools);
          // Use Gemini's streaming API with proper handlers
          await gemini.streamGeminiMessage({
            apiKey,
            model,
            messages: convertChatMessagesToGeminiFormat(messages),
            temperature: temperature || 0.7,
            maxTokens: maxTokens || 50000,
            systemMessage,
            tools: geminiTools,
            chatMode,
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 24576
            },
            onStart: () => { streamStats.startTime = Date.now(); logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Stream started for model ${model}`); },
            onReasoningChunk: (chunk: string) => {
              // Send reasoning chunks as separate message type
              sendToClient(ws, {
                type: MessageType.PROVIDER_REASONING_CHUNK,
                payload: {
                  chunk,
                  requestId: safeRequestId,
                  provider,
                  model
                }
              });
            },
            onChunk: (chunk: string) => {
              // Update stream stats
              streamStats.chunkCount++; streamStats.totalCharsStreamed += chunk.length; streamStats.lastPingTime = Date.now();
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
            },
            onError: (error: Error) => {
              logger.error(
                `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Streaming error after tool: ${error.message}`
              );
            },
            onComplete: (response: any) => {
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

              // Log tool call information if present
              const toolCall = response.toolCall;
              if (toolCall) {
                logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Tool call detected in onComplete: ${toolCall.name}, args: ${JSON.stringify(toolCall.parameters)}`);

                // Store context for multi-turn
                const toolCalls: ToolCall[] = [toolCall].map(tc => ({
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.parameters),
                  },
                }));

                activeTurnContexts.set(safeRequestId, {
                  provider, model, apiKey, temperature, maxTokens, systemMessage, tools, parallelToolCalls, stream, lastPrompt: String(prompt),
                  messages: [
                    ...messages,
                    { role: 'assistant', content: response.text || '', tool_calls: toolCalls }
                  ],
                  createdAt: Date.now()
                });
                
              }

              sendToClient(ws, {
                type: MessageType.PROVIDER_STREAM_END,
                payload: {
                  success: response.success,
                  text: response.text,
                  tokensUsed: response.tokensUsed,
                  toolCall: toolCall ? {
                    id: toolCall.id,
                    name: toolCall.name,
                    args: toolCall.parameters
                  } : undefined,
                  requestId: safeRequestId,
                  provider,
                  model,
                  waitingForToolCall: !!toolCall
                }
              });

              // Clean up the context if we are not waiting for a tool call result
              if (!toolCall) {
                activeTurnContexts.delete(safeRequestId);
              }
            }
          });
        } catch (error: any) {
          logger.error(
            `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
            `Error in streaming setup: ${error instanceof Error ? error.message : String(error)}`
          );
          sendToClient(ws, {
            type: MessageType.PROVIDER_ERROR,
            payload: {
              error: `Streaming error: ${error instanceof Error ? error.message : String(error)}`,
              code: 'STREAMING_ERROR',
              requestId: safeRequestId,
              provider,
              model
            }
          });
          activeTurnContexts.delete(safeRequestId);
        }
      } else {
        // Handle non-streaming response with improved logging
        const geminiTools = convertToolsToGeminiFormat(tools);
        const response: any = await gemini.sendGeminiMessage({
          apiKey,
          model,
          messages: convertChatMessagesToGeminiFormat(messages),
          temperature: temperature || 0.7,
          maxTokens: maxTokens || 50000,
          systemMessage,
          tools: geminiTools,
          chatMode: promptContext.chatMode,
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 24576
          }
        });

        logger.info(`Provider Response (Non-Stream) [${safeRequestId}]: ` +
          `Success: ${response.success}, Tokens Used: ${response.tokensUsed}, Text Length: ${response.text?.length || 0}, ` +
          `ToolCall: ${response.toolCall ? response.toolCall.name : 'none'}, WaitingForToolCall: ${!!response.toolCall}`);

        const toolCallData = response.toolCall;

        // Log tool call information if present
        if (toolCallData) {
          logger.info(
            `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] ` +
            `Tool call detected in response: ${toolCallData.name}, ` +
            `parameters: ${JSON.stringify(toolCallData.parameters)}`
          );

          const toolCalls: ToolCall[] = [toolCallData].map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.parameters),
            },
          }));

          // Store the conversation context
          activeTurnContexts.set(safeRequestId, {
            provider,
            model,
            apiKey,
            temperature,
            maxTokens,
            systemMessage,
            tools,
            parallelToolCalls,
            stream: false,
            lastPrompt: String(prompt),
            messages: [...(messages || []), { role: 'assistant', content: response.text || '', tool_calls: toolCalls }],
            createdAt: Date.now()
          });

          sendToClient(ws, {
            type: MessageType.PROVIDER_RESPONSE,
            payload: {
              text: response.text,
              tokensUsed: response.tokensUsed,
              success: true,
              requestId: safeRequestId,
              provider,
              model,
              toolCall: toolCallData ? {
                id: toolCallData.id,
                name: toolCallData.name,
                args: toolCallData.parameters
              } : undefined,
              waitingForToolCall: !!toolCallData
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
              success: true,
              requestId: safeRequestId,
              provider,
              model,
              toolCall: toolCallData ? {
                id: toolCallData.id,
                name: toolCallData.name,
                args: toolCallData.parameters
              } : undefined,
              waitingForToolCall: !!toolCallData
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
    } else if (provider === 'mistral') {
      const apiKey = process.env.MISTRAL_API_KEY;

      // Destructure model from payload and define modelToUse early for use in all paths, including API key error
      const { model } = message.payload; 
      const modelToUse = model || 'mistral-small-latest';

      if (!apiKey) {
        logger.error(`WS MISTRAL [${ws.connectionData.connectionId}][${safeRequestId}] MISTRAL_API_KEY not configured`);
        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
            error: 'Mistral API key not configured on server',
            code: 'API_KEY_MISSING',
            requestId: safeRequestId,
            provider,
            model: modelToUse // Use modelToUse which has a default
          }
        });
        return;
      }

      // 'model' is destructured above, and 'modelToUse' is defined based on it.
      const { stream, messages, prompt, suffix, temperature, maxTokens, toolChoice, requestType } = message.payload;
      // modelToUse is already defined above.
      const userId = ws.connectionData.userId; // Get userId for logging usage

      // Properly initialize chatMode as a valid string value (like Gemini does)
      const userChatMode = promptContext.chatMode;
      const chatMode: 'normal' | 'gather' | 'agent' =
        userChatMode === 'gather' ? 'gather' :
        userChatMode === 'normal' ? 'normal' : 'agent';

      logger.info(
        `WS MISTRAL [${ws.connectionData.connectionId}][${safeRequestId}] Request: ` +
        `Model=${modelToUse}, Type=${requestType || 'chat'}, Stream=${stream}, Temp=${temperature}, ` +
        `MaxTokens=${maxTokens}, Tools=${tools ? tools.map((t: any) => t.name).join(', ') : 'none'}`
      );

      const streamStats = { startTime: 0, chunkCount: 0, totalCharsStreamed: 0, lastChunkTime: 0 };
      const elapsedMs = Date.now() - streamStats.startTime;
      const charsPerSecond = streamStats.totalCharsStreamed / (elapsedMs / 1000);

      if (stream) {
        try {
          const commonStreamHandlers = {
            onStart: () => {
              streamStats.startTime = Date.now();
              logger.info(`WS MISTRAL [${ws.connectionData.connectionId}][${safeRequestId}] Stream started for model ${modelToUse}`);
            },
            onStream: (chunk: string) => { // onStream from mistral.ts maps to this
              streamStats.chunkCount++;
              streamStats.totalCharsStreamed += chunk.length;
              streamStats.lastChunkTime = Date.now();
              sendToClient(ws, {
                type: MessageType.PROVIDER_STREAM_CHUNK,
                payload: {
                  chunk,
                  requestId: safeRequestId,
                  provider,
                  model: modelToUse // Correct for Mistral's onStream
                }
              });
            },
            onError: (error: Error) => {
              logger.error(
                `WS MISTRAL [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                `Streaming error after tool: ${error.message}`
              );
            }
          };

          if (requestType === 'fim') {
            await mistral.processFIM({
              apiKey,
              model: modelToUse,
              prefix: String(prompt || ''),
              suffix: String(suffix || ''),
              temperature,
              maxTokens,
              stream: true,
              ...commonStreamHandlers,
              onFinal: (fullText: string, tokensUsed?: number) => {
                const elapsedMs = Date.now() - streamStats.startTime;
                const charsPerSecond = streamStats.totalCharsStreamed / (elapsedMs / 1000);
                logger.info(
                  `WS MISTRAL FIM [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                  `Stream complete: ${streamStats.chunkCount} chunks, ` +
                  `${streamStats.totalCharsStreamed} chars, ` +
                  `${elapsedMs}ms total time, ` +
                  `${charsPerSecond.toFixed(1)} chars/sec, ` +
                  `${tokensUsed || 0} tokens used`
                );
                sendToClient(ws, {
                  type: MessageType.PROVIDER_STREAM_END,
                  payload: {
                    tokensUsed,
                    success: true,
                    requestId: safeRequestId,
                    provider,
                    model: modelToUse,
                    text: fullText // Include the accumulated text in the correct field
                  }
                });
              }
            });
          } else { // Default to chat
            await mistral.processChat({
              apiKey,
              model: modelToUse,
              messages: messages || [{ role: 'user', content: String(prompt || '') }],
              systemMessage, // ✅ ADDED: Pass system message to Mistral
              temperature,
              maxTokens,
              stream: true,
              tools: tools.map(t => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: (t as any).parameters,
                },
              })),
              toolChoice, // ✅ ADDED: Re-enable tool choice support
              chatMode, // ✅ ADDED: Missing chatMode parameter
              ...commonStreamHandlers,
              onFinal: (fullText: string, tokensUsed?: number, toolCalls?: MistralToolCall[], finishReason?: string | null, reasoning?: string) => { // ✅ ADDED: reasoning parameter
                logger.info(
                  `WS MISTRAL Chat [${ws.connectionData.connectionId}][${safeRequestId}] ` +
                  `Stream complete: ${streamStats.chunkCount} chunks, ` +
                  `${streamStats.totalCharsStreamed} chars, ` +
                  `${elapsedMs}ms total time, ` +
                  `${charsPerSecond.toFixed(1)} chars/sec, ` +
                  `${tokensUsed || 0} tokens used, FinishReason: ${finishReason}`
                );

                if (toolCalls && toolCalls.length > 0) {
                  logger.info(`WS MISTRAL Chat [${ws.connectionData.connectionId}][${safeRequestId}] Tool calls received: ${JSON.stringify(toolCalls)}`);
                  // ✅ ADDED: Store context for tool execution feedback loop
                  activeTurnContexts.set(safeRequestId, {
                    provider: 'mistral',
                    model: modelToUse,
                    apiKey,
                    temperature,
                    maxTokens,
                    systemMessage,
                    tools,
                    parallelToolCalls,
                    stream: true,
                    lastPrompt: String(prompt || ''),
                    messages: [...(messages || []), { role: 'assistant', content: fullText, tool_calls: toolCalls as any[] }],
                    createdAt: Date.now()
                  });
                }

                const toolCallPayload = toolCalls && toolCalls.length > 0 ? {
                  id: toolCalls[0].id,
                  name: toolCalls[0].function?.name,
                  args: JSON.parse(String(toolCalls[0].function?.arguments || '{}'))
                } : undefined;

                sendToClient(ws, {
                  type: MessageType.PROVIDER_STREAM_END,
                  payload: {
                    tokensUsed,
                    success: true, 
                    requestId: safeRequestId,
                    provider,
                    model: modelToUse,
                    text: fullText,
                    reasoning: reasoning, // ✅ ADDED: Include reasoning in non-streaming response
                    toolCall: toolCallPayload,
                    waitingForToolCall: !!toolCallPayload
                  }
                });
                if (userId && tokensUsed) {
                  logUsage(userId, provider, modelToUse, tokensUsed);
                }
              }
            });
          }
        } catch (error) {
            logger.error(
              `WS MISTRAL [${ws.connectionData.connectionId}][${safeRequestId}] ` +
              `Error in streaming setup: ${error instanceof Error ? error.message : String(error)}`
            );
            sendToClient(ws, {
              type: MessageType.PROVIDER_ERROR,
              payload: {
                error: `Streaming error: ${error instanceof Error ? error.message : String(error)}`,
                code: 'STREAMING_ERROR',
                requestId: safeRequestId,
                provider,
                model: modelToUse // Correct for Mistral's streaming catch block
              }
            });
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
  if (message.type !== MessageType.USER_DATA_REQUEST) {
    logger.error('Invalid message type passed to handleUserDataRequest');
    return;
  }
  
  const { userId } = message.payload;

  logger.info(`👤 User data request for ${userId}`);

  try {
    // Authorization check
    if (config.authEnabled && userId !== ws.connectionData.userId) {
      logger.warn(`🚫 Unauthorized user data request: ${userId} !== ${ws.connectionData.userId}`);
      sendToClient(ws, {
        type: MessageType.USER_DATA_RESPONSE,
        payload: { error: 'Unauthorized' } 
      });
      return;
    }

    // Get user data from both Clerk and DB in parallel for efficiency
    const [clerkUserData, dbUser] = await Promise.all([
      getClerkUserData(userId),
      getUserByClerkId(userId)
    ]);
    
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
    
    logger.info(`✅ User data retrieved for ${userId}`);
    sendToClient(ws, {
      type: MessageType.USER_DATA_RESPONSE, 
      payload: { user: userData } 
    });

  } catch (error) {
    logger.error('Error fetching user data:', error);
    sendToClient(ws, {
      type: MessageType.USER_DATA_RESPONSE, 
      payload: { error: 'Failed to fetch user data' } 
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
  const safeRequestId = requestId || `tool-exec-${uuidv4().substring(0, 8)}`;
  const userId = ws.connectionData.userId;

  let resultPreview: string;
  if (isError) {
    resultPreview = `Error: ${errorDetails ? String(errorDetails).substring(0, 50) : 'Unknown'}`;
  } else if (typeof result === 'string') {
    resultPreview = `String(len:${result.length})${result.length > 50 ? ", " + result.substring(0, 50) + "..." : ""}`;
  } else if (typeof result === 'object' && result !== null) {
    resultPreview = `Object(keys:${Object.keys(result).join(', ').substring(0, 50)})`;
  } else {
    resultPreview = String(result).substring(0, 50);
  }

  logger.info(`Tool Execution Result [${safeRequestId}]: ToolName: ${toolName}, ToolCallId: ${toolCallId}, IsError: ${isError}, ResultPreview: ${resultPreview}`);

  if (!userId && config.authEnabled) {
    logger.error(`WS AUTH [${ws.connectionData.connectionId}][${safeRequestId}] No user ID available for tool execution result`);
    sendToClient(ws, { type: MessageType.PROVIDER_ERROR, payload: { error: 'User ID not available', code: 'NO_USER_ID', requestId: safeRequestId } });
    return;
  }

  logger.info(`Processing tool execution result for ${toolName} from user ${userId || 'anonymous'}, requestId: ${safeRequestId}`);

  try {
    const conversationContext = activeTurnContexts.get(safeRequestId);

    if (!conversationContext) {
      logger.error(`WS [${ws.connectionData.connectionId}][${safeRequestId}] No active conversation found for tool execution result`);
      sendToClient(ws, { type: MessageType.PROVIDER_ERROR, payload: { error: 'No active conversation found for this tool call', code: 'NO_ACTIVE_CONVERSATION', requestId: safeRequestId } });
      return;
    }

    const { provider, model, apiKey, temperature, maxTokens, systemMessage, tools, parallelToolCalls, stream, messages } = conversationContext;
    
    const toolResponseContent = isError ? { error: errorDetails || 'Unknown error during tool execution' } : result;
    const toolResponseString = typeof toolResponseContent === 'string' ? toolResponseContent : JSON.stringify(toolResponseContent);

    messages.push({ role: 'tool', tool_call_id: toolCallId, content: toolResponseString });

    logger.info(`WS ${provider.toUpperCase()} [${ws.connectionData.connectionId}][${safeRequestId}] Continuing conversation with tool result for ${toolName}`);

    const userChatMode = message.payload.chatMode;
    const requestChatMode: 'normal' | 'gather' | 'agent' = userChatMode === 'gather' ? 'gather' : userChatMode === 'normal' ? 'normal' : 'agent';

    if (stream) {
      const streamStats = { startTime: Date.now(), chunkCount: 0, totalCharsStreamed: 0, lastChunkTime: Date.now() };

      if (provider === 'mistral') {
        // ... (Mistral logic)
      } else { // Gemini
        const geminiTools = convertToolsToGeminiFormat(tools || []);
        await gemini.streamGeminiMessage({
          apiKey, model, messages: convertChatMessagesToGeminiFormat(messages), temperature: temperature || 0.7, maxTokens: maxTokens || 50000, systemMessage, tools: geminiTools, chatMode: requestChatMode,
          thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 },
          onStart: () => { streamStats.startTime = Date.now(); logger.info(`WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Continued stream started for model ${model}`); },
          onReasoningChunk: (chunk: string) => { sendToClient(ws, { type: MessageType.PROVIDER_REASONING_CHUNK, payload: { chunk, requestId: safeRequestId, provider, model } }); },
          onChunk: (chunk: string) => {
            streamStats.chunkCount++; streamStats.totalCharsStreamed += chunk.length; streamStats.lastChunkTime = Date.now();
            sendToClient(ws, { type: MessageType.PROVIDER_STREAM_CHUNK, payload: { chunk, requestId: safeRequestId, provider, model } });
          },
          onComplete: (response: LLMResponse) => {
            sendToClient(ws, {
              type: MessageType.PROVIDER_STREAM_END,
              payload: {
                success: response.success,
                text: response.text,
                tokensUsed: response.tokensUsed,
                toolCall: response.toolCall ? {
                  id: response.toolCall.id,
                  name: response.toolCall.name,
                  args: response.toolCall.parameters
                } : undefined,
                requestId: safeRequestId,
                provider,
                model,
                waitingForToolCall: !!response.toolCall
              }
            });
            activeTurnContexts.delete(safeRequestId);
          },
          onError: (error: Error) => {
            logger.error(
              `WS GEMINI [${ws.connectionData.connectionId}][${safeRequestId}] Streaming error after tool: ${error.message}`
            );
          }
        });
      }
    } else {
      // Non-streaming logic
    }
  } catch (error) {
    logger.error(`Error processing tool execution result for ${toolName}:`, error);
    sendToClient(ws, { type: MessageType.PROVIDER_ERROR, payload: { error: `Failed to process tool execution result for ${toolName}`, code: 'TOOL_EXECUTION_RESULT_ERROR', requestId: safeRequestId } });
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
      // Progress updates are no longer sent to the client as per user request.
      // The client will only be notified upon completion or error.
      // Log the progress internally for debugging.
      let logMessage = `[${ws.connectionData.connectionId}][${requestId}] Embedding progress (not sent to client): ${progress.completedChunks}/${progress.totalChunks} chunks`;
      if (progress.totalChunks > 0) {
        logMessage += ` (${Math.round((progress.completedChunks / progress.totalChunks) * 100)}%)`;
      }
      logMessage += ` - Batch ${progress.currentBatchNumber}/${progress.totalBatches}`;
      if (progress.currentFileRelativePath) {
        logMessage += ` - File: ${progress.currentFileRelativePath}`;
      }
      if (progress.fileStatus) {
        logMessage += ` - Status: ${progress.fileStatus}`;
      }
      if (progress.fileErrorDetails) {
        logMessage += ` - Error: ${progress.fileErrorDetails}`;
      }
      logger.debug(logMessage);
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
    const pineconeService = await import('./pinecone-service');
    // @ts-ignore
    const result = await pineconeService.clearUserIndex(userId, workspaceId);
    sendToClient(ws, {
      type: MessageType.CODEBASE_CLEAR_INDEX_RESPONSE,
      payload: {
        requestId,
        success: result.success,
        error: result.error,
        deletedVectorCount: result.deletedVectorCount,
        workspaceId
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    logger.error(`WS CLEAR_INDEX [${ws.connectionData.connectionId}][${requestId}] Failed to clear index for user ${userId}: ${errorMessage}`);
    sendToClient(ws, {
      type: MessageType.CODEBASE_CLEAR_INDEX_RESPONSE,
      payload: {
        requestId,
        success: false,
        error: errorMessage,
        workspaceId
      }
    });
  }
}

export default {
  setupServer,
  setupWebSocketServer,
  startWebSocketServer
};