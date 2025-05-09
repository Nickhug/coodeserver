import express from 'express';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import { config } from './config';
import logger from '@repo/logger';
import { verifyToken, getDbUserByClerkId } from '@repo/auth';
import { MessageType, ClientMessage, ServerMessage } from '@repo/types';
import * as gemini from '@repo/ai-providers';
import { logUsage, verifyAndConsumeAuthToken, getUserByClerkId } from '@repo/db';

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

// Store active connections
const connections = new Map<string, WebSocketConnectionData>();

/**
 * Set up the HTTP server and WebSocket server
 */
export function setupServer(): http.Server {
  // Create Express app
  const app = express();
  
  // Configure CORS
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true
  }));
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  
  // Create HTTP server
  const server = http.createServer(app);
  
  return server;
}

/**
 * Set up the WebSocket server
 */
export function setupWebSocketServer(server: http.Server): WebSocketServer {
  // Create WebSocket server
  const wss = new WebSocketServer({ 
    server,
    path: config.wsPath 
  });
      
  // Set up ping interval for connection keepalive
  global.setInterval(() => {
    const now = Date.now();
    
    wss.clients.forEach((ws) => {
      const wsWithData = ws as WebSocketWithData;
      
      if (!wsWithData.connectionData) {
        return;
      }
      
      const timeSinceLastPing = now - wsWithData.connectionData.lastPingTime;
      
      if (timeSinceLastPing > config.pingInterval * 2) {
        logger.warn(`Connection ${wsWithData.connectionData.connectionId} timed out, closing`);
        ws.terminate();
        return;
      }
      
      // Send ping
      try {
        ws.ping();
      } catch (error) {
        logger.error('Error sending ping:', error);
      }
    });
  }, config.pingInterval);
  
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
  
  // Check authentication if enabled
  let token: string | undefined = undefined;
  
  // Extract token from request headers
  if (config.authEnabled) {
    // Extract token from Sec-WebSocket-Protocol header
    const protocol = req.headers['sec-websocket-protocol'];
    if (protocol) {
      token = protocol;
    }
  }
  
  // Set up WebSocket with connection data
  const wsWithData = ws as WebSocketWithData;
  wsWithData.connectionData = {
    connectionId,
    userId,
    isAuthenticated,
    lastPingTime: Date.now()
  };
  
  // Store connection
  connections.set(connectionId, wsWithData.connectionData);
  
  // Log connection
  logger.info(`WebSocket connection opened: ${connectionId}`);
  
  // Send welcome message
  sendToClient(wsWithData, {
    type: isAuthenticated ? MessageType.AUTH_SUCCESS : MessageType.CONNECT_SUCCESS,
    payload: {
      connectionId,
      userId: userId || null,
      serverTime: new Date().toISOString(),
      serverInfo: {
        environment: config.environment
      }
    }
  });
  
  // If token was provided, authenticate
  if (token) {
    // We'll authenticate in the message handler to keep this function simpler
    handleIncomingMessage(wsWithData, JSON.stringify({
      type: MessageType.AUTHENTICATE,
      payload: { token }
    }));
  }
  
  // Set up event handlers
  ws.on('message', (data) => handleIncomingMessage(wsWithData, data.toString()));
  
  ws.on('close', (code, reason) => {
    // Remove connection
          connections.delete(connectionId);
    
    // Log disconnection
    logger.info(`WebSocket connection closed: ${connectionId} ${userId ? `(User: ${userId})` : ''} with code ${code}`);
  });
  
  ws.on('error', (error) => {
    logger.error(`WebSocket error on connection ${connectionId}:`, error);
  });
  
  // Update ping time on pong
  ws.on('pong', () => {
    wsWithData.connectionData.lastPingTime = Date.now();
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
    
    // Update last ping time
    ws.connectionData.lastPingTime = Date.now();
    
    // Handle message by type
    switch (clientMessage.type) {
      case MessageType.PING:
        sendToClient(ws, { type: MessageType.PONG, payload: { serverTime: Date.now() } });
        break;
        
      case MessageType.AUTHENTICATE:
        await handleAuthentication(ws, clientMessage);
        break;
        
      case MessageType.PROVIDER_LIST:
        await handleProviderList(ws);
        break;
        
      case MessageType.PROVIDER_MODELS:
        await handleProviderModels(ws, clientMessage);
        break;
        
      case MessageType.PROVIDER_REQUEST:
        if (config.authEnabled && !isAuthenticated) {
          sendToClient(ws, { 
            type: MessageType.PROVIDER_ERROR, 
            payload: { 
              error: 'Authentication required', 
              code: 'UNAUTHORIZED' 
            } 
          });
          return;
        }
        await handleProviderRequest(ws, clientMessage);
        break;
        
      default:
        logger.warn(`Unknown message type: ${clientMessage.type}`);
        sendToClient(ws, { 
          type: MessageType.ERROR, 
          payload: { 
            error: `Unknown message type: ${clientMessage.type}`, 
            code: 'UNKNOWN_MESSAGE_TYPE' 
          } 
        });
    }
  } catch (error) {
    logger.error(`Error handling message from ${connectionId}:`, error);
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
 * Send a message to a WebSocket client
 */
function sendToClient(ws: WebSocketWithData, message: ServerMessage): void {
  try {
    const messageText = JSON.stringify({
      ...message,
      timestamp: Date.now()
    });
    
    // Send the message, checking for state
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageText);
    } else {
      logger.warn(`WebSocket not in OPEN state, current state: ${ws.readyState}`);
    }
  } catch (error) {
    logger.error('Error sending message to client:', error);
  }
}

/**
 * Start the WebSocket server
 */
export function startWebSocketServer(): http.Server {
  const server = setupServer();
  const wss = setupWebSocketServer(server);
  
  // Start listening
  server.listen(config.port, () => {
    logger.info(`WebSocket server listening on ${config.host}:${config.port}${config.wsPath}`);
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
    const verificationResult = await verifyAndConsumeAuthToken(token);
    
    if (!verificationResult) {
      logger.warn(`Authentication failed for ${connectionId}: Invalid token`);
      sendToClient(ws, {
        type: MessageType.AUTH_FAILURE,
        payload: {
          error: 'Invalid authentication token',
          code: 'INVALID_TOKEN'
        }
      });
      return;
    }
    
    const userId = verificationResult.userId;
    
    // Set connection as authenticated
    ws.connectionData.userId = userId;
    ws.connectionData.isAuthenticated = true;
    connections.set(connectionId, ws.connectionData);
    
    // Get user data from DB
    const user = await getUserByClerkId(userId);
    
    // Create user data object to send
    const userData = user ? {
      id: userId,
      email: user.email,
      credits: user.credits_remaining,
      subscription: user.subscription_tier
    } : { id: userId };
    
    // Send authentication success message
    logger.info(`Authentication successful for connection ${connectionId} for user ${userId}`);
    sendToClient(ws, {
      type: MessageType.AUTH_SUCCESS,
      payload: {
        userId,
        connectionId,
        user: userData,
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
              id: 'gemini-1.5-flash',
              name: 'Gemini 1.5 Flash',
              provider: 'gemini',
              available: true,
              contextWindow: 128000,
              maxOutputTokens: 8192,
              features: ['streaming', 'toolCalls']
            },
            {
              id: 'gemini-1.5-pro',
              name: 'Gemini 1.5 Pro',
              provider: 'gemini',
              available: true,
              contextWindow: 1000000,
              maxOutputTokens: 32768,
              features: ['streaming', 'toolCalls']
            },
            {
              id: 'gemini-pro',
              name: 'Gemini Pro',
              provider: 'gemini',
              available: true,
              contextWindow: 32768,
              maxOutputTokens: 8192,
              features: ['streaming', 'toolCalls']
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

  const { provider, model, prompt, temperature, maxTokens, stream = false } = message.payload;
  const userId = ws.connectionData.userId;
  
  if (!userId && config.authEnabled) {
    logger.error('No user ID available for provider request');
    sendToClient(ws, {
      type: MessageType.PROVIDER_ERROR,
      payload: {
        error: 'User ID not available',
        code: 'NO_USER_ID'
      }
    });
    return;
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
          code: 'PROVIDER_NOT_CONFIGURED'
        }
      });
      return;
}

    // Process based on provider
    if (provider === 'gemini') {
      if (stream) {
        // Handle streaming response
        await gemini.sendLLMRequest({
          provider: 'gemini',
          model,
          prompt,
          temperature: temperature || 0.7,
          maxTokens: maxTokens || 1024,
          apiKey,
          userId
        });

        // Since we're not using streaming with the current provider,
        // we'll implement a simplified response
        sendToClient(ws, {
          type: MessageType.PROVIDER_STREAM_START,
          payload: {
            provider,
            model
          }
        });

        sendToClient(ws, {
          type: MessageType.PROVIDER_STREAM_CHUNK,
          payload: {
            chunk: "Sorry, streaming is currently not fully implemented yet."
          }
        });

        sendToClient(ws, {
          type: MessageType.PROVIDER_STREAM_END,
          payload: {
            tokensUsed: 0,
            success: true
          }
        });
      } else {
        // Handle non-streaming response
        const response = await gemini.sendLLMRequest({
          provider: 'gemini',
          model,
          prompt,
          temperature: temperature || 0.7,
          maxTokens: maxTokens || 1024,
          apiKey,
          userId
        });
        
        sendToClient(ws, {
          type: MessageType.PROVIDER_RESPONSE,
          payload: {
            text: response.text,
            tokensUsed: response.tokensUsed,
            success: response.success,
            ...(response.error && { error: response.error })
          }
        });
        
        // Log usage
        if (userId && response.tokensUsed) {
          // Calculate credits used based on token usage
          const creditsUsed = response.creditsUsed || (response.tokensUsed / 1000);
          
          // Log the usage
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

export default {
  setupServer,
  setupWebSocketServer,
  startWebSocketServer
};
