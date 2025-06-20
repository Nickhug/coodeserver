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
  ToolCall,
  SendLLMMessagePayload
} from '@repo/types';
import * as types from '@repo/types';
import { deleteVectors as pineconeDeleteVectors } from './pinecone-service';
import * as documentProcessingService from './document-processing-service';
import * as gemini from '@repo/ai-providers';
import * as mistral from './mistral';
import * as openrouter from './openrouter';
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

/**
 * Convert ChatMessage array to GeminiMessage array format
 */
export function convertChatMessagesToGeminiFormat(messages: any[]): any[] {
  return messages.map(message => {
    if (message.role === 'user') {
      return {
        role: 'user',
        parts: [{ text: message.content }]
      };
    } else if (message.role === 'assistant' || message.role === 'model') {
      return {
        role: 'model',
        parts: [{ text: message.content }]
      };
    } else if (message.role === 'tool') {
      // Tool responses are handled differently in Gemini
      return {
        role: 'model',
        parts: [{ text: `Tool result: ${message.content}` }]
      };
    } else {
      // Default to user role for unknown roles
      return {
        role: 'user',
        parts: [{ text: message.content }]
      };
    }
  });
}

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
  stream: boolean; // Must be a boolean
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

// Store AbortControllers for active LLM requests
const abortControllers = new Map<string, Map<string, AbortController>>();

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
async function handleIncomingMessage(ws: WebSocketWithData, messageStr: string): Promise<void> {
  try {
    const message: ClientMessage = JSON.parse(messageStr);
    const { type, payload, requestId } = message;
  const { connectionId, userId, isAuthenticated } = ws.connectionData;
    const safeRequestId = requestId || 'no-request-id';

    logger.info(`WS MSG [${connectionId}][${safeRequestId}] Received message type: ${type}`);

    // Route message to the appropriate handler
    switch (type) {
      case MessageType.AUTHENTICATE:
        await handleAuthentication(ws, message);
        break;
      
      case MessageType.PROVIDER_LIST:
      await handleProviderList(ws);
        break;

      case MessageType.PROVIDER_MODELS:
        await handleProviderModels(ws, message);
        break;

      case MessageType.GET_SERVER_MODELS:
        await handleGetServerModels(ws, message);
        break;

      case MessageType.SEND_LLM_MESSAGE:
        if (!isAuthenticated) {
          sendToClient(ws, { type: MessageType.AUTH_FAILURE, requestId });
        return;
      }
        await handleProviderRequest(ws, message);
        break;
      
      case MessageType.CANCEL_LLM_REQUEST:
        handleCancelRequest(ws, message);
        break;

      case MessageType.TOOL_EXECUTION_RESULT:
        if (!isAuthenticated) {
          sendToClient(ws, { type: MessageType.AUTH_FAILURE, requestId });
        return;
      }
        await handleToolExecutionResult(ws, message);
        break;

      case MessageType.PING:
        logger.debug(`WS MSG [${connectionId}] Ping received`);
        sendToClient(ws, { type: MessageType.PONG, requestId, payload: { timestamp: Date.now(), serverTime: new Date().toISOString(), connectionId } });
        break;

      case MessageType.USER_DATA_REQUEST:
        logger.info(`WS MSG [${connectionId}][${safeRequestId}] User data request`);
        await handleUserDataRequest(ws, message);
        break;

      case MessageType.FIM_REQUEST: {
        const { provider, model } = message.payload || {};
        logger.info(`WS MSG [${connectionId}][${safeRequestId}] FIM request: ${provider || 'unknown'}/${model || 'unknown'}`);
      if (config.authEnabled && !isAuthenticated) {
           logger.warn(`WS AUTH [${connectionId}][${safeRequestId}] Unauthorized FIM request rejected`);
           sendToClient(ws, { type: MessageType.ERROR, requestId: safeRequestId, payload: { error: 'Authentication required', code: 'UNAUTHORIZED' }});
        return;
      }
        await handleFimRequest(ws, message);
        break;
      }
      
      // Handle other specific cases like CODEBASE_... requests here, ensuring auth checks
      case MessageType.CODEBASE_SEARCH_REQUEST: {
        logger.info(`WS MSG [${connectionId}][${safeRequestId}] Codebase search request`);
      if (config.authEnabled && !isAuthenticated) {
            logger.warn(`WS AUTH [${connectionId}][${safeRequestId}] Unauthorized codebase search request rejected`);
            sendToClient(ws, { type: MessageType.ERROR, requestId: safeRequestId, payload: { error: 'Authentication required', code: 'UNAUTHORIZED' } });
        return;
      }
        await handleCodebaseSearchRequest(ws, message);
        break;
      }

      default:
        // Generic catch-all for legacy or unhandled messages.
        // Add auth checks for sensitive legacy messages if any.
        logger.warn(`WS MSG [${connectionId}] Unhandled or unknown message type: ${type}`);
        sendToClient(ws, { type: MessageType.ERROR, requestId, payload: { error: `Unknown or unhandled message type: ${type}`, code: 'UNKNOWN_MESSAGE_TYPE' } });
        break;
    }
  } catch (error) {
    const { connectionId = 'unknown' } = (ws as WebSocketWithData).connectionData || {};
    logger.error(`WS ERROR [${connectionId}] Error processing message: ${error instanceof Error ? error.message : String(error)}`, error);
    const messagePreview = messageStr.length > 200 ? `${messageStr.substring(0, 200)}...` : messageStr;
    logger.debug(`WS ERROR [${connectionId}] Problematic message preview: ${messagePreview}`);
    sendToClient(ws, { type: MessageType.ERROR, payload: { error: 'Failed to process message on server.', code: 'MESSAGE_PROCESSING_ERROR' } });
  }
}

/**
 * Send message to client with optimizations for streaming
 */
function sendToClient(ws: WebSocketWithData, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
    // Add timestamp to all outgoing messages
    const messageWithTimestamp = { ...message, timestamp: Date.now() };
    ws.send(JSON.stringify(messageWithTimestamp));
    logger.info(`WS MSG OUT [${ws.connectionData.connectionId}][${message.requestId}] Sent message type: ${message.type}`);
    } else {
    logger.warn(`WS MSG OUT [${ws.connectionData.connectionId}][${message.requestId}] Attempted to send to closed socket, type: ${message.type}`);
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
  const server = setupServer();
  setupWebSocketServer(server);
  setupHttpRoutes(server); // Pass server instance here
  
  server.listen(config.port, config.host, () => {
    logger.info(`🚀 Server listening on ${config.host}:${config.port}`);
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
      },
      {
        id: 'openRouter',
        name: 'OpenRouter',
        available: Boolean(config.openrouterApiKey),
      },
    ];

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
 * Handle get server models request - returns all available models from all providers
 */
async function handleGetServerModels(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  const { requestId } = message;

  try {
    const allModels: any[] = [];
    
    if (config.openrouterApiKey) {
      logger.info(`[${requestId}] Fetching models from OpenRouter...`);
      const openRouterModels = await openrouter.listModels(config.openrouterApiKey);
      
      const formattedModels = openRouterModels.map((model: any) => ({
        id: model.id,
        name: model.name,
        providerName: 'openRouter', // Important for the client
        modelName: model.id,
        type: 'server',
        available: true,
        contextWindow: model.context_length,
        maxOutputTokens: model.top_provider?.max_completion_tokens,
        features: ['streaming', 'toolCalls'] // Assuming standard features
      }));

      allModels.push(...formattedModels);
      logger.info(`[${requestId}] Fetched ${formattedModels.length} models from OpenRouter.`);
    } else {
      logger.warn(`[${requestId}] OPENROUTER_API_KEY not set. Cannot fetch models.`);
    }

    logger.info(`[${requestId}] Sending ${allModels.length} server models.`);

    // Send server models list
    sendToClient(ws, {
      type: MessageType.SERVER_MODELS_LIST,
      payload: {
        models: allModels,
        requestId: requestId
      }
    });

  } catch (error) {
    logger.error(`[${requestId}] Error getting server models:`, error);
    sendToClient(ws, {
      type: MessageType.ERROR,
      payload: {
        error: 'Failed to get server models',
        code: 'SERVER_MODELS_ERROR',
        requestId: requestId,
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
      case 'openai':
        if (config.openaiApiKey) {
          available = true;
          // models = await openAI.listModels(config.openaiApiKey);
        }
        break;

      case 'groq':
        if (config.groqApiKey) {
          available = true;
          // models = await groq.listModels(config.groqApiKey);
        }
        break;

      case 'openrouter':
      case 'openRouter':
        if (config.openrouterApiKey) {
          available = true;
          models = await openrouter.listModels(config.openrouterApiKey);
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
  const { provider, model, messages, temperature, maxTokens, stream, tools, toolChoice } = message.payload;
  const safeRequestId = message.requestId ?? `req-${Date.now()}`;
  const { userId, connectionId } = ws.connectionData;

  if (!userId) {
    throw new Error('User not authenticated');
  }

  logger.info(`WS PROVIDER REQUEST [${connectionId}][${safeRequestId}] User: ${userId}, Provider: ${provider}, Model: ${model}`);

  try {
    const onStream = (text: string, toolCalls?: ToolCall[] | undefined) => {
      sendToClient(ws, { type: MessageType.PROVIDER_STREAM_CHUNK, requestId: safeRequestId, payload: { chunk: text, functionCalls: toolCalls } });
    };

    const onComplete = (response: LLMResponse) => {
      logger.info(`PROVIDER REQUEST [${safeRequestId}] COMPLETED for provider ${provider}`);
      sendToClient(ws, {
        type: MessageType.PROVIDER_STREAM_END,
        requestId: safeRequestId,
        payload: {
          success: response.success ?? true,
          text: response.text,
          tokensUsed: response.usage?.totalTokens ?? 0,
          error: response.error,
          tool_calls: response.tool_calls,
          finish_reason: response.finish_reason,
        }
      });
      activeTurnContexts.delete(safeRequestId);
    };

    const onError = (error: Error) => {
      logger.error(`PROVIDER REQUEST [${safeRequestId}] FAILED for provider ${provider}: ${error.message}`, error);
      sendToClient(ws, {
        type: MessageType.PROVIDER_ERROR,
        requestId: safeRequestId,
        payload: {
          error: error.name,
          message: error.message
        }
      });
      activeTurnContexts.delete(safeRequestId);
    };

    const providerImplementations: Record<string, any> = {
      'gemini': gemini.streamGeminiMessage,
      'mistral': mistral.processChat,
      'openrouter': openrouter.processChat,
      'openRouter': openrouter.processChat,
    };

    const processChat = providerImplementations[provider];
    if (processChat) {
      const commonParams: any = {
        model,
        messages,
        tools,
        toolChoice,
        stream: true,
        onStream,
        onComplete,
        onError,
      };

      switch (provider) {
        case 'gemini':
          if (!config.geminiApiKey) {
            return onError(new Error('Gemini API key not configured.'));
          }
          await processChat({
            ...commonParams,
            apiKey: config.geminiApiKey,
          });
          break;
        case 'mistral':
          if (!config.mistralApiKey) {
            return onError(new Error('Mistral API key not configured.'));
          }
          await processChat({
            ...commonParams,
            apiKey: config.mistralApiKey,
          });
          break;
        case 'openrouter':
        case 'openRouter':
          if (!config.openrouterApiKey) {
            return onError(new Error('OpenRouter API key not configured.'));
          }
          await processChat({
            ...commonParams,
            apiKey: config.openrouterApiKey,
            siteUrl: config.openrouterSiteUrl,
            appName: config.openrouterAppName,
          });
          break;
        default:
          onError(new Error(`Provider '${provider}' is not supported.`));
          break;
      }
    } else {
      onError(new Error(`Provider '${provider}' is not supported.`));
    }
  } catch (error) {
    logger.error(`Error processing provider request:`, error);
    sendToClient(ws, { type: MessageType.PROVIDER_ERROR, requestId: safeRequestId, payload: { error: 'Failed to process provider request', code: 'PROVIDER_REQUEST_ERROR' } });
    activeTurnContexts.delete(safeRequestId);
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
        await gemini.streamGeminiMessage({
          apiKey, model, messages: convertChatMessagesToGeminiFormat(messages), temperature: temperature || 0.7, maxTokens: maxTokens || 50000, systemMessage, tools: tools || [], chatMode: requestChatMode,
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
                tokensUsed: response.usage?.totalTokens,
                tool_calls: response.tool_calls,
                requestId: safeRequestId,
                provider,
                model,
                waitingForToolCall: !!response.tool_calls && response.tool_calls.length > 0
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
          results: [{ chunk: { id: 'stats', content: `Vector count: ${vectorCount}` } }],
          error: null
        }
      });
      return;
    }
    
    logger.info(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] Processing search request for user ${userId}: "${query}"`);

    // Import services
    const embeddingService = await import('./embedding-service');
    const pineconeService = await import('./pinecone-service');

    // Generate query embedding
    const { embedding, error: embeddingError } = await embeddingService.generateQueryEmbedding(query, userId);

    if (embeddingError) {
      throw new Error(embeddingError);
    }

    // Perform search
    const searchResults = await pineconeService.hybridSearch(userId, query, embedding, {
      ...options,
      workspaceId,
    });
    
    // Log search results count
    logger.info(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] Found ${searchResults.length} results for query: "${query}"`);


    // Send response
    sendToClient(ws, {
      type: MessageType.CODEBASE_SEARCH_RESPONSE,
      payload: {
        requestId,
        results: searchResults
      }
    });

  } catch (error) {
    logger.error(`WS SEARCH [${ws.connectionData.connectionId}][${requestId}] Error processing search request:`, error);
    sendToClient(ws, {
      type: MessageType.CODEBASE_SEARCH_RESPONSE,
      payload: {
        requestId,
        results: [],
        error: error instanceof Error ? error.message : String(error)
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

/**
 * Handles a request to cancel an ongoing LLM stream.
 */
function handleCancelRequest(ws: WebSocketWithData, message: ClientMessage): void {
  const { requestId } = message;
  const safeConnectionId = ws.connectionData.connectionId || 'unknown';

  if (!requestId) {
    logger.warn(`WS CANCEL [${safeConnectionId}] Received cancel request without a requestId.`);
    return;
  }
  
  const connectionAbortControllers = abortControllers.get(safeConnectionId);
  if (connectionAbortControllers && connectionAbortControllers.has(requestId)) {
    const abortController = connectionAbortControllers.get(requestId);
    abortController?.abort(); // Send abort signal
    connectionAbortControllers.delete(requestId); // Clean up
    logger.info(`WS CANCEL [${safeConnectionId}][${requestId}] Aborted request.`);
    sendToClient(ws, { type: MessageType.LLM_STREAM_END, requestId }); // Notify client stream has ended
  } else {
    logger.warn(`WS CANCEL [${safeConnectionId}][${requestId}] No active abort controller found for this request.`);
  }
}

export default {
  setupServer,
  setupWebSocketServer,
  startWebSocketServer
};