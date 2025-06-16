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
import { initClerk, getClerkUserData } from '@repo/auth';
import { 
  MessageType, 
  ClientMessage, 
  ServerMessage
} from '@repo/types';
import * as documentProcessingService from './document-processing-service';
import {
  getUserByClerkId,
  verifyAndConsumeAuthToken,
  logUsage,
  AuthTokenVerificationResult
} from '@repo/db';
import { availableTools, chat_systemMessage } from './prompts/prompts';
import { convertToolsToGeminiFormat, validateToolConversion } from './toolConverter';
import { streamGeminiMessage, LLMResponse, GeminiMessage } from '@repo/ai-providers';

// --- TYPE DEFINITIONS ---

interface WebSocketConnectionData {
  connectionId: string;
  userId?: string;
  isAuthenticated: boolean;
  lastPingTime: number;
}

interface WebSocketWithData extends WebSocket {
  connectionData: WebSocketConnectionData;
}

interface TurnContext {
  provider: string;
  model: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  parallelToolCalls?: boolean;
  stream: boolean;
  lastPrompt: string;
  messages: GeminiMessage[];
  createdAt: number;
  promptContext: PromptContext;
}

interface PromptContext {
  cwd?: string;
  os?: string;
  voidVersion?: string;
  activeFileContent?: string;
  activeEditorSelection?: string;
  directoryStr?: string;
  openedURIs?: string[];
  activeURI?: string;
  persistentTerminalIDs?: string[];
  chatMode: 'normal' | 'agent' | 'gather';
}

// --- GLOBAL STATE ---

const connections = new Map<string, WebSocketConnectionData>();
const activeTurnContexts = new Map<string, TurnContext>();
const TURN_CONTEXT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Cleanup stale turn contexts
setInterval(() => {
  const now = Date.now();
  for (const [requestId, context] of activeTurnContexts.entries()) {
    if (now - context.createdAt > TURN_CONTEXT_TIMEOUT_MS) {
      activeTurnContexts.delete(requestId);
      logger.info(`Cleaned up stale turn context for requestId: ${requestId}`);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// --- SERVER SETUP ---

export function setupServer(): http.Server {
  const app = express();

  // Initialize Clerk if configured
  if (process.env.CLERK_SECRET_KEY) {
    initClerk(process.env.CLERK_SECRET_KEY, process.env.CLERK_JWT_KEY, process.env.CLERK_PUBLISHABLE_KEY);
  }
  
  // Middleware
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS']
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    logger.info(`HTTP Request: ${req.method} ${req.url}`);
    next();
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      connections: connections.size,
      activeTurns: activeTurnContexts.size
    });
  });
  
  return http.createServer(app);
}

export function setupWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: config.wsPath,
    maxPayload: 100 * 1024 * 1024 // 100MB
  });
  
  // Ping/pong for connection health
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const wsWithData = ws as WebSocketWithData;
      if (wsWithData.connectionData && 
          wsWithData.connectionData.lastPingTime < Date.now() - (config.pingInterval * 3)) {
        logger.warn(`Terminating connection due to ping timeout: ${wsWithData.connectionData.connectionId}`);
        return ws.terminate();
      }
        ws.ping();
    });
  }, config.pingInterval);

  wss.on('close', () => clearInterval(pingInterval));
  wss.on('connection', handleConnection);

  logger.info(`WebSocket server configured at ${config.wsPath}`);
  return wss;
}

export function startWebSocketServer(): http.Server {
  validateConfig();
  const server = setupServer();
  setupWebSocketServer(server);
  const { port, host } = config;
  
  server.listen(port, host, () => {
    logger.info(`🚀 COODE AI Server listening on http://${host}:${port}`);
    logger.info(`📡 WebSocket endpoint: ws://${host}:${port}${config.wsPath}`);
  });
  
  return server;
}

// --- WEBSOCKET HANDLERS ---

function handleConnection(ws: WebSocket): void {
  const connectionId = uuidv4();
  const wsWithData = ws as WebSocketWithData;
  
  wsWithData.connectionData = { 
    connectionId,
    isAuthenticated: false, 
    lastPingTime: Date.now()
  };

  connections.set(connectionId, wsWithData.connectionData);
  logger.info(`🔌 New connection established: ${connectionId}`);

  // Send CONNECT_SUCCESS message immediately
  sendToClient(wsWithData, {
    type: MessageType.CONNECT_SUCCESS,
    payload: {
      connectionId,
      userId: null,
      serverTime: new Date().toISOString(),
      serverInfo: {
        environment: process.env.NODE_ENV || 'development'
      }
    }
  });

  ws.on('message', (message: string) => handleIncomingMessage(wsWithData, message));
  ws.on('pong', () => { wsWithData.connectionData.lastPingTime = Date.now(); });
  ws.on('close', () => { 
    connections.delete(connectionId);
    logger.info(`🔌 Connection closed: ${connectionId}`); 
  });
  ws.on('error', (error) => { 
    logger.error(`🔌 Connection error for ${connectionId}:`, error); 
  });
}

async function handleIncomingMessage(ws: WebSocketWithData, messageStr: string): Promise<void> {
  try {
    const message: ClientMessage = JSON.parse(messageStr);
    const { connectionId } = ws.connectionData;
    
    logger.debug(`📨 Received ${message.type} from ${connectionId}`);
    
    switch (message.type) {
      case MessageType.AUTHENTICATE:
        await handleAuthentication(ws, message);
        break;
        
      case MessageType.PING:
        // Respond to client ping with pong
        sendToClient(ws, {
          type: MessageType.PONG,
          payload: {}
        });
        break;
        
      case MessageType.PROVIDER_LIST:
        await handleProviderListRequest(ws, message);
        break;
        
      case MessageType.PROVIDER_MODELS:
        await handleProviderModelsRequest(ws, message);
        break;
        
      case MessageType.PROVIDER_REQUEST:
        await handleProviderRequest(ws, message);
        break;
        
      case MessageType.TOOL_EXECUTION_RESULT:
        await handleToolExecutionResult(ws, message);
        break;
        
      case MessageType.USER_DATA_REQUEST:
        await handleUserDataRequest(ws, message);
        break;
        
      case MessageType.CODEBASE_EMBEDDING_REQUEST:
      case MessageType.CODEBASE_EMBEDDING_BATCH_REQUEST:
      case MessageType.CODEBASE_SEARCH_REQUEST:
      case MessageType.CODEBASE_DELETE_VECTORS_REQUEST:
        logger.warn(`⚠️ Unimplemented message type: ${message.type}`);
        sendErrorToClient(ws, `Message type ${message.type} is not implemented.`);
        break;
        
      default:
        logger.warn(`⚠️ Unknown message type: ${message.type}`);
        sendErrorToClient(ws, `Unknown message type: ${message.type}`);
    }
      } catch (error) {
    logger.error(`❌ Failed to handle message for ${ws.connectionData.connectionId}:`, error);
    sendErrorToClient(ws, 'Failed to process message', error instanceof Error ? error.message : String(error));
  }
}

function sendToClient(ws: WebSocketWithData, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    } else {
    logger.warn(`⚠️ Attempted to send message to closed WebSocket: ${ws.connectionData.connectionId}`);
  }
}

function sendErrorToClient(ws: WebSocketWithData, message: string, details?: string): void {
    sendToClient(ws, {
      type: MessageType.ERROR,
      payload: {
      message, 
      ...(details && { error: details }),
      timestamp: new Date().toISOString()
    } 
  });
}

// --- AUTHENTICATION HANDLER ---

async function handleAuthentication(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.AUTHENTICATE) return;
  
  const { token } = message.payload;
  const { connectionId } = ws.connectionData;
  
  logger.info(`🔐 Authenticating connection ${connectionId}`);
  
  try {
    if (config.authEnabled) {
      const verificationResult = await verifyAndConsumeAuthToken(token);
      
      if ('userId' in verificationResult) {
        // Success case
        ws.connectionData.isAuthenticated = true;
        ws.connectionData.userId = verificationResult.userId;
        
        logger.info(`✅ Connection ${connectionId} authenticated for user ${verificationResult.userId}`);
    sendToClient(ws, {
          type: MessageType.AUTH_SUCCESS, 
      payload: {
            success: true, 
            userId: verificationResult.userId,
            connectionId 
          } 
        });
      } else {
        // Error case
        logger.warn(`❌ Authentication failed for ${connectionId}: ${verificationResult.errorMessage}`);
        sendToClient(ws, {
          type: MessageType.AUTH_FAILURE, 
          payload: {
            success: false, 
            error: verificationResult.errorMessage 
          } 
        });
      }
    } else {
      // Auth disabled - auto-authenticate
      ws.connectionData.isAuthenticated = true;
      ws.connectionData.userId = 'anonymous_user';
      
      logger.info(`🔓 Authentication disabled. Connection ${connectionId} auto-authenticated.`);
    sendToClient(ws, {
        type: MessageType.AUTH_SUCCESS, 
      payload: {
          success: true, 
          userId: 'anonymous_user',
          connectionId 
        } 
      });
    }
  } catch (error) {
    logger.error(`❌ Authentication error for ${connectionId}:`, error);
    sendToClient(ws, {
      type: MessageType.AUTH_FAILURE, 
      payload: {
          success: false,
        error: 'Authentication service error' 
      } 
    });
  }
}

// --- PROVIDER LIST HANDLER ---

async function handleProviderListRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.PROVIDER_LIST) return;

  const { connectionId } = ws.connectionData;
  logger.info(`📋 Fetching provider list for connection ${connectionId}`);

  try {
    // Import providers from ai-providers package
    const { providers } = await import('@repo/ai-providers');
    
    // Filter to only available providers that we support on the server
    const availableProviders = providers
      .filter(provider => provider.available)
      .map(provider => ({
        id: provider.id,
        name: provider.name,
        available: provider.available
      }));

    sendToClient(ws, {
      type: MessageType.PROVIDER_LIST,
      payload: {
        providers: availableProviders,
        defaultProvider: 'gemini' // Set Gemini as default
      }
    });

    logger.info(`✅ Sent ${availableProviders.length} providers to ${connectionId}`);
  } catch (error) {
    logger.error(`❌ Error fetching provider list for ${connectionId}:`, error);
    sendToClient(ws, {
      type: MessageType.ERROR,
      payload: {
        message: 'Failed to fetch provider list',
        error: error instanceof Error ? error.message : String(error),
        code: 'PROVIDER_LIST_ERROR'
      }
    });
  }
}

// --- PROVIDER MODELS HANDLER ---

async function handleProviderModelsRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.PROVIDER_MODELS) return;

  const { provider } = message.payload;
  const { connectionId } = ws.connectionData;
  
  logger.info(`🔧 Fetching models for provider ${provider} for connection ${connectionId}`);

  try {
    // Import providers from ai-providers package
    const { providers } = await import('@repo/ai-providers');
    
    // Find the requested provider
    const providerInfo = providers.find(p => p.id === provider);
    
    if (!providerInfo) {
      sendToClient(ws, {
        type: MessageType.PROVIDER_MODELS,
        payload: {
          provider,
          available: false,
          models: []
        }
      });
      return;
    }

    // Return the models for this provider
    sendToClient(ws, {
      type: MessageType.PROVIDER_MODELS,
      payload: {
        provider,
        available: providerInfo.available,
        models: providerInfo.models
      }
    });

    logger.info(`✅ Sent ${providerInfo.models.length} models for ${provider} to ${connectionId}`);
  } catch (error) {
    logger.error(`❌ Error fetching models for provider ${provider} for ${connectionId}:`, error);
    sendToClient(ws, {
      type: MessageType.PROVIDER_MODELS,
      payload: {
        provider,
        available: false,
        models: []
      }
    });
  }
}

// --- PROVIDER REQUEST HANDLER ---

async function handleProviderRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.PROVIDER_REQUEST) return;

      const {
    provider, 
    model, 
    messages, 
        temperature,
        maxTokens,
    stream = true, 
    requestId: clientRequestId, 
    parallelToolCalls, 
    promptContext 
  } = message.payload;
  
  const requestId = clientRequestId || uuidv4();
    const { connectionId } = ws.connectionData;

  logger.info(`🤖 Processing ${provider}/${model} request ${requestId} from ${connectionId}`);

  try {
    // Validate prompt context
    if (!promptContext) {
      logger.error(`❌ Missing promptContext for request ${requestId}`);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
          requestId, 
          message: 'Internal server error: promptContext is missing.',
          code: 'MISSING_PROMPT_CONTEXT'
        } 
      });
    return;
  }

    // Generate tools and system prompt from server-side prompts.ts
    const internalTools = availableTools(promptContext.chatMode);
    const systemPrompt = chat_systemMessage({
      workspaceFolders: promptContext.cwd ? [promptContext.cwd] : [],
      directoryStr: promptContext.directoryStr || '',
      openedURIs: promptContext.openedURIs || [],
      activeURI: promptContext.activeURI,
      persistentTerminalIDs: promptContext.persistentTerminalIDs || [],
      chatMode: promptContext.chatMode,
      includeXMLToolDefinitions: true,
      os: promptContext.os || 'unknown'
    });

    logger.info(`🛠️ Generated ${internalTools.length} tools for chatMode: ${promptContext.chatMode}`);

    // Convert tools to Gemini API format
    const geminiTools = convertToolsToGeminiFormat(internalTools);
    
    // Validate conversion in development
    if (process.env.NODE_ENV === 'development') {
      internalTools.forEach((tool, index) => {
        if (geminiTools[0]?.functionDeclarations[index]) {
          validateToolConversion(tool, geminiTools[0].functionDeclarations[index]);
        }
      });
    }

    // Validate provider and get API key
    let apiKey: string;
    if (provider === 'gemini') {
      apiKey = config.geminiApiKey;
    } else {
      logger.error(`❌ Unknown provider: ${provider}`);
        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
          error: `Unknown provider: ${provider}`, 
          code: 'UNKNOWN_PROVIDER', 
          requestId 
          }
        });
        return;
    }

    if (!apiKey) {
      logger.error(`❌ Provider ${provider} not configured`);
      sendToClient(ws, {
        type: MessageType.PROVIDER_ERROR,
        payload: {
          error: `Provider ${provider} is not configured`, 
          code: 'PROVIDER_NOT_CONFIGURED', 
          requestId 
        }
      });
      return;
    }

    // Store turn context for tool execution follow-ups
    const turnContext: TurnContext = {
            provider,
            model,
        apiKey,
      temperature,
      maxTokens,
        stream,
      messages: messages || [],
      lastPrompt: messages?.[messages.length - 1]?.parts?.[0]?.text || '',
      createdAt: Date.now(),
      parallelToolCalls,
      promptContext
    };
    
    activeTurnContexts.set(requestId, turnContext);

    // Handle Gemini requests
    if (provider === 'gemini') {
      await handleGeminiRequest(ws, requestId, {
        apiKey,
              model,
        messages: messages || [],
        systemMessage: systemPrompt,
        tools: geminiTools,
        temperature,
        maxTokens,
        stream
      });
    }

  } catch (error) {
    logger.error(`❌ Error processing provider request ${requestId}:`, error);
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        requestId, 
        message: 'Internal server error during request processing',
        error: error instanceof Error ? error.message : String(error)
      } 
    });
    activeTurnContexts.delete(requestId);
  }
}

// --- GEMINI REQUEST HANDLER ---

async function handleGeminiRequest(
  ws: WebSocketWithData, 
  requestId: string, 
  params: {
    apiKey: string;
    model: string;
    messages: GeminiMessage[];
    systemMessage: string;
    tools: any[];
    temperature?: number;
    maxTokens?: number;
    stream: boolean;
  }
): Promise<void> {
  const { apiKey, model, messages, systemMessage, tools, temperature, maxTokens, stream } = params;

  logger.info(`🔮 Starting Gemini ${model} request ${requestId} with ${tools.length} tools`);

  try {
    // Stream start notification
      if (stream) {
          sendToClient(ws, {
            type: MessageType.PROVIDER_STREAM_START,
        payload: { requestId } 
      });
    }

    // Set up streaming handlers
    const onChunk = (chunk: string) => {
                  sendToClient(ws, {
                    type: MessageType.PROVIDER_STREAM_CHUNK,
        payload: { requestId, chunk } 
      });
    };

    const onComplete = (finalResponse: LLMResponse) => {
      logger.info(`✅ Gemini request ${requestId} completed. Tool call: ${!!finalResponse.toolCall}`);

              sendToClient(ws, {
                type: MessageType.PROVIDER_STREAM_END,
                payload: {
          requestId, 
          response: finalResponse, 
          success: true 
        } 
      });

      // Clean up context if no tool call is waiting
      if (!finalResponse.toolCall) {
        activeTurnContexts.delete(requestId);
        logger.debug(`🧹 Cleaned up turn context for completed request ${requestId}`);
      }
    };

    const onError = (error: Error) => {
      logger.error(`❌ Gemini request ${requestId} failed:`, error);
      
        sendToClient(ws, {
          type: MessageType.PROVIDER_ERROR,
          payload: {
          requestId, 
          message: error.message, 
          fullError: error.stack 
        } 
      });
      
      activeTurnContexts.delete(requestId);
    };

    // Call Gemini API
    await streamGeminiMessage({
              apiKey,
      model,
      messages,
                    systemMessage,
                    tools,
              temperature,
              maxTokens,
      onChunk,
      onComplete,
      onError
    });

        } catch (error) {
    logger.error(`❌ Error in Gemini request ${requestId}:`, error);
            sendToClient(ws, {
              type: MessageType.PROVIDER_ERROR,
              payload: {
        requestId, 
        message: 'Failed to process Gemini request',
        error: error instanceof Error ? error.message : String(error)
      } 
    });
    activeTurnContexts.delete(requestId);
  }
}

// --- TOOL EXECUTION RESULT HANDLER ---

async function handleToolExecutionResult(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.TOOL_EXECUTION_RESULT) return;

  const { requestId, toolCallId, toolName, result, isError, errorDetails } = message.payload;
  const { connectionId } = ws.connectionData;
  
  logger.info(`🔧 Tool execution result for ${toolName} in request ${requestId} from ${connectionId}`);
  
  try {
    const turnContext = activeTurnContexts.get(requestId);
    if (!turnContext) {
      logger.error(`❌ No active turn context found for tool execution result: ${requestId}`);
      sendErrorToClient(ws, `No active context for request ${requestId}`);
      return;
    }

    // Construct function response message in Gemini format
    const functionResponseMessage: GeminiMessage = {
      role: 'user',
      parts: [{
        functionResponse: {
          name: toolName,
          response: {
            result: isError ? `Error: ${errorDetails || result}` : result
          }
        }
      } as any] // Gemini API supports functionResponse but types may not be updated
    };

    // Update message history
    const newMessages: GeminiMessage[] = [
      ...turnContext.messages,
      functionResponseMessage
    ];
    
    turnContext.messages = newMessages;
    activeTurnContexts.set(requestId, turnContext);

    logger.info(`🔄 Continuing conversation for request ${requestId} after tool execution`);

    // Continue the conversation with updated message history
    await handleProviderRequest(ws, {
      type: MessageType.PROVIDER_REQUEST,
      payload: {
        provider: turnContext.provider,
        model: turnContext.model,
        messages: newMessages,
        temperature: turnContext.temperature,
        maxTokens: turnContext.maxTokens,
        stream: turnContext.stream,
        requestId: requestId,
        parallelToolCalls: turnContext.parallelToolCalls,
        promptContext: turnContext.promptContext
      }
    });

  } catch (error) {
    logger.error(`❌ Error handling tool execution result for ${requestId}:`, error);
    sendErrorToClient(ws, 'Failed to process tool execution result', error instanceof Error ? error.message : String(error));
    activeTurnContexts.delete(requestId);
  }
}

// --- USER DATA REQUEST HANDLER ---

async function handleUserDataRequest(ws: WebSocketWithData, message: ClientMessage): Promise<void> {
  if (message.type !== MessageType.USER_DATA_REQUEST) return;
  
  const { userId } = message.payload;
  const { connectionId } = ws.connectionData;

  logger.info(`👤 User data request for ${userId} from ${connectionId}`);

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

    // Fetch user data
    const [dbUser, clerkUser] = await Promise.all([
      getUserByClerkId(userId),
      getClerkUserData(userId)
    ]);
    
    const userData = {
      id: userId,
      email: dbUser?.email || clerkUser?.email || '',
      credits: dbUser?.credits_remaining || 0,
      subscription: dbUser?.subscription_tier || 'free',
      name: clerkUser?.name,
      firstName: clerkUser?.firstName,
      lastName: clerkUser?.lastName,
      avatarUrl: clerkUser?.avatarUrl
    };
    
    logger.info(`✅ User data retrieved for ${userId}`);
      sendToClient(ws, {
      type: MessageType.USER_DATA_RESPONSE, 
      payload: { user: userData } 
    });

  } catch (error) {
    logger.error(`❌ Error fetching user data for ${userId}:`, error);
    sendToClient(ws, {
      type: MessageType.USER_DATA_RESPONSE, 
      payload: { error: 'Failed to fetch user data' } 
    });
  }
}

// --- EXPORTS ---

export default { setupServer, setupWebSocketServer, startWebSocketServer };