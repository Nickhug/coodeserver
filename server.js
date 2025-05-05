const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const ws = require('ws');
const { verifyToken } = require('@clerk/backend');

// Make sure we have the WebSocketServer
const WebSocketServer = ws.WebSocketServer || ws.Server;

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

// Store authenticated WebSocket connections with their user IDs
const connections = new Map();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling request:', err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  // Initialize WebSocket server
  const wss = new WebSocketServer({
    server,
    path: '/api/ws',
    // Allow all connections initially, we'll handle authentication after connection
    verifyClient: (info, callback) => {
      console.log(`[WebSocket Auth] Client connecting from origin: ${info.origin}`);
      // Accept all connections initially
      return callback(true);
    }
  });

  // Handle WebSocket connections
  wss.on('connection', (ws, req) => {
    const connectionId = Math.random().toString(36).substring(2, 15);

    console.log(`[WebSocket Manager] Connection attempt received. Assigning ID: ${connectionId}`);

    try {
      // Store the connection without requiring authentication initially
      connections.set(connectionId, ws);
      console.log(`[WebSocket Manager] Client connected and stored: ${connectionId}`);

      // Send connection ID back to the client
      ws.send(JSON.stringify({ type: 'connection', connectionId }));
      console.log(`[WebSocket Manager] Sent connectionId ${connectionId} to client.`);

      // Handle messages
      ws.on('message', async (message) => {
        console.log(`[WebSocket Manager] Received message from ${connectionId}: ${message}`);
        try {
          const parsedMessage = JSON.parse(message.toString());

          if (parsedMessage.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else {
            // Handle other message types here
            console.log(`[WebSocket Manager] Handling message type ${parsedMessage.type} for ${connectionId}`);
          }
        } catch (error) {
          console.error(`[WebSocket Manager] Error processing message from ${connectionId}:`, error);
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to process message' }));
        }
      });

      // Handle connection close
      ws.on('close', () => {
        connections.delete(connectionId);
        console.log(`[WebSocket Manager] Client disconnected: ${connectionId}`);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error(`[WebSocket Manager] WebSocket error for ${connectionId}:`, error);
        connections.delete(connectionId); // Ensure cleanup on error
      });
    } catch (error) {
      console.error(`[WebSocket Manager] Error during initial connection setup for ${connectionId}:`, error);
      try {
        ws.terminate(); // Attempt to close the connection gracefully on error
      } catch (terminateError) {
        console.error(`[WebSocket Manager] Error terminating WebSocket for ${connectionId} after setup error:`, terminateError);
      }
    }
  });

  // Export a function to send auth success messages
  global.sendAuthSuccess = (connectionId, token, userData) => {
    const ws = connections.get(connectionId);
    console.log(`Attempting to send auth success to ${connectionId}`);
    if (ws) {
      ws.send(JSON.stringify({
        type: 'auth:success',
        token,
        user: userData
      }));
      console.log(`Sent auth success to ${connectionId}`);
      return true;
    } else {
      console.log(`WebSocket connection ${connectionId} not found.`);
    }
    return false;
  };

  // Handle server errors
  wss.on('error', (error) => {
    console.error("FATAL: WebSocketServer emitted error:", error);
  });

  // Start the server
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const HOST = process.env.HOST || '0.0.0.0'; // Use 0.0.0.0 to listen on all interfaces
  server.listen(PORT, HOST, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://${HOST}:${PORT}`);
    console.log(`> WebSocket server attached and listening on ws://${HOST}:${PORT}/api/ws`);
  });
});
