import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

// Interface for dynamically loaded WebSocket services
interface IDynamicWebSocketService {
  initialize?: (wss: WebSocketServer) => void;
  setupWebsocketHandlers?: (wss: WebSocketServer) => void;
}

// Define an interface for the imported module
interface GeminiServiceModule {
  GeminiWebSocketService: new () => IDynamicWebSocketService;
}

/**
 * Initialize the WebSocket server and dynamically load/initialize services.
 */
export async function initWebSocketServer(server: HttpServer): Promise<WebSocketServer> {
  console.log('[WS Manager] Initializing WebSocket server...');
  
  const wssInstance = new WebSocketServer({ server });
  
  try {
    // In ESM, we need to use import.meta.url and fileURLToPath to get the directory path
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    
    console.log(`[WS Manager] Current directory: ${__dirname}`);
    
    // Determine the correct path based on the deployment environment
    // In production Docker container, the structure is typically:
    // /app/websocket-server/dist/manager.js (this file)
    // /app/.next/standalone/node_modules/.pnpm/... (node_modules)
    // /app/.next/server/chunks/... (compiled Next.js code)
    
    // Try multiple potential paths to find the service
    const potentialPaths = [
      // Path for development
      path.resolve(__dirname, '../../src/lib/gemini-ws-handler/GeminiWebSocketService.js'),
      // Path for production in Docker container
      path.resolve(__dirname, '../../.next/server/src/lib/gemini-ws-handler/GeminiWebSocketService.js'),
      // Fallback path if Next.js puts compiled output elsewhere
      path.resolve(__dirname, '../../.next/standalone/src/lib/gemini-ws-handler/GeminiWebSocketService.js'),
    ];
    
    let geminiServiceModule: GeminiServiceModule | null = null;
    let loadedPath = '';
    
    // Try each path until we find the module
    for (const servicePath of potentialPaths) {
      try {
        console.log(`[WS Manager] Attempting to import from: ${servicePath}`);
        // Using dynamic import with type assertion
        const importedModule = await import(servicePath) as GeminiServiceModule;
        if (typeof importedModule.GeminiWebSocketService === 'function') {
          geminiServiceModule = importedModule;
          loadedPath = servicePath;
          console.log(`[WS Manager] Successfully imported from: ${servicePath}`);
          break;
        } else {
          console.log(`[WS Manager] Import succeeded but GeminiWebSocketService is not a function in: ${servicePath}`);
        }
      } catch (error) {
        // Log the error message but continue to the next path
        console.log(`[WS Manager] Import failed for path: ${servicePath}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue to the next path
      }
    }
    
    if (!geminiServiceModule) {
      throw new Error('Failed to import GeminiWebSocketService from any of the potential paths');
    }
    
    console.log(`[WS Manager] Initializing GeminiWebSocketService from: ${loadedPath}`);
    const geminiServiceInstance = new geminiServiceModule.GeminiWebSocketService();
    
    // Call initialize or setupWebsocketHandlers if they exist on the service instance
    if (typeof geminiServiceInstance.initialize === 'function') {
      geminiServiceInstance.initialize(wssInstance);
      console.log('[WS Manager] GeminiWebSocketService initialized via initialize().');
    } else if (typeof geminiServiceInstance.setupWebsocketHandlers === 'function') {
      geminiServiceInstance.setupWebsocketHandlers(wssInstance);
      console.log('[WS Manager] GeminiWebSocketService initialized via setupWebsocketHandlers().');
    } else {
      console.warn('[WS Manager] GeminiWebSocketService instance has no initialize or setupWebsocketHandlers method.');
    }
  } catch (error) {
    console.error('[WS Manager] Error loading or initializing GeminiWebSocketService:', error);
  }
  
  // Generic heartbeat mechanism for all connections managed at this level
  wssInstance.on('connection', (socket: WebSocket) => {
    console.log('[WS Manager] WebSocket connection established (manager level).');
    
    // Add isAlive property to socket for heartbeat
    interface ExtendedWebSocket extends WebSocket {
      isAlive: boolean;
    }
    const extendedSocket = socket as ExtendedWebSocket;
    extendedSocket.isAlive = true;
    
    socket.on('pong', () => {
      extendedSocket.isAlive = true;
    });
    
    // Basic message logging at manager level (services should handle their specific messages)
    socket.on('message', (message: RawData) => {
      try {
        let len = 0;
        let messageType = 'Unknown';

        if (Buffer.isBuffer(message)) {
            len = message.length;
            messageType = 'Buffer';
        } else if (typeof message === 'string') { // For text messages
            len = Buffer.byteLength(message, 'utf8');
            messageType = 'String';
        } else if (message instanceof ArrayBuffer) { 
            len = message.byteLength;
            messageType = 'ArrayBuffer';
        } else if (Array.isArray(message)) { // Buffer[]
            len = message.reduce((sum, buf) => sum + (Buffer.isBuffer(buf) ? buf.length : 0), 0);
            messageType = `Buffer[] (count: ${message.length})`;
            console.log('[WS Manager] Received array of Buffers. Total Length: %d', len);
        } else {
            console.log('[WS Manager] Received message of unhandled RawData type.');
        }

        if (len > 0) {
            console.log('[WS Manager] Received message (%s, length: %d bytes) on WebSocket server (manager level).', messageType, len);
        } else {
             console.log('[WS Manager] Received empty or non-standard message on WebSocket server (manager level). Type: %s', messageType);
        }
      } catch (error) {
        console.error('[WS Manager] Error processing/logging WebSocket message at manager level:', error);
      }
    });

    socket.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : 'N/A';
      console.log(`[WS Manager] WebSocket connection closed (manager level). Code: ${code}, Reason: ${reasonStr}`);
    });

    socket.on('error', (error) => {
      console.error('[WS Manager] WebSocket connection error (manager level):', error);
    });
  });
  
  // Set up interval to ping clients and terminate dead connections
  const interval = setInterval(() => {
    wssInstance.clients.forEach((clientSocket: WebSocket) => {
      const extendedSocket = clientSocket as WebSocket & { isAlive?: boolean }; // isAlive might not be set if connection happened before this loop iteration
      
      if (extendedSocket.isAlive === false) { // Check if isAlive is explicitly false
        console.log('[WS Manager] Terminating dead WebSocket connection.');
        return clientSocket.terminate();
      }
      
      extendedSocket.isAlive = false; // Set to false, expect a pong to set it back to true
      clientSocket.ping(() => {}); // Add noop callback to prevent unhandled error events on ping
    });
  }, 30000); // 30 seconds
  
  wssInstance.on('close', () => {
    console.log('[WS Manager] WebSocket server closing, clearing heartbeat interval.');
    clearInterval(interval);
  });
  
  console.log('[WS Manager] WebSocket server initialized and listening.');
  return wssInstance;
}

