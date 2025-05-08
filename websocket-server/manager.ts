import { Server as HttpServer } from 'http';
import { Server as WebSocketServer, WebSocket, RawData } from 'ws';

// Interface for dynamically loaded WebSocket services
interface IDynamicWebSocketService {
  initialize?: (wss: WebSocketServer) => void;
  setupWebsocketHandlers?: (wss: WebSocketServer) => void;
  // No index signature, methods are optional
}

/**
 * Initialize the WebSocket server and dynamically load/initialize services.
 */
export async function initWebSocketServer(server: HttpServer): Promise<WebSocketServer> {
  console.log('[WS Manager] Initializing WebSocket server...');
  
  const wssInstance = new WebSocketServer({ server });
  
  try {
    // Dynamically import the GeminiWebSocketService.
    // Ensure the path points to the compiled .js file for ES module resolution.
    const GeminiServiceModule = await import('../src/lib/gemini-ws-handler/GeminiWebSocketService.js');
    
    if (GeminiServiceModule && typeof GeminiServiceModule.GeminiWebSocketService === 'function') {
      console.log('[WS Manager] Initializing GeminiWebSocketService...');
      const geminiServiceInstance = new GeminiServiceModule.GeminiWebSocketService();
      
      // Call initialize or setupWebsocketHandlers if they exist on the service instance
      if (typeof (geminiServiceInstance as IDynamicWebSocketService).initialize === 'function') {
        (geminiServiceInstance as IDynamicWebSocketService).initialize?.(wssInstance);
        console.log('[WS Manager] GeminiWebSocketService initialized via initialize().');
      } else if (typeof (geminiServiceInstance as IDynamicWebSocketService).setupWebsocketHandlers === 'function') {
        (geminiServiceInstance as IDynamicWebSocketService).setupWebsocketHandlers?.(wssInstance);
        console.log('[WS Manager] GeminiWebSocketService initialized via setupWebsocketHandlers().');
      } else {
        console.warn('[WS Manager] GeminiWebSocketService instance has no initialize or setupWebsocketHandlers method.');
      }
    } else {
      console.error('[WS Manager] Failed to load GeminiWebSocketService: GeminiWebSocketService export not found or not a function.');
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
      console.log(`[WS Manager] WebSocket connection closed (manager level). Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
    });

    socket.on('error', (error) => {
      console.error('[WS Manager] WebSocket connection error (manager level):', error);
    });
  });
  
  // Set up interval to ping clients and terminate dead connections
  const interval = setInterval(() => {
    wssInstance.clients.forEach((socket) => {
      const extendedSocket = socket as WebSocket & { isAlive?: boolean }; // isAlive might not be set if connection happened before this loop iteration
      
      if (extendedSocket.isAlive === false) { // Check if isAlive is explicitly false
        console.log('[WS Manager] Terminating dead WebSocket connection.');
        return socket.terminate();
      }
      
      extendedSocket.isAlive = false; // Set to false, expect a pong to set it back to true
      socket.ping(() => {}); // Add noop callback to prevent unhandled error events on ping
    });
  }, 30000); // 30 seconds
  
  wssInstance.on('close', () => {
    console.log('[WS Manager] WebSocket server closing, clearing heartbeat interval.');
    clearInterval(interval);
  });
  
  console.log('[WS Manager] WebSocket server initialized and listening.');
  return wssInstance;
}

