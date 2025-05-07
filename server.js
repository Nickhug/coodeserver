import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
// const ws = require('ws'); // No longer need 'ws' directly here
// const { verifyToken } = require('@clerk/backend'); // verifyToken will be handled by the new manager

// Import the new WebSocket server initializer with the correct path to the compiled file
import { initWebSocketServer } from './websocket-server/dist/manager.js';

// Make sure we have the WebSocketServer - NO LONGER NEEDED HERE
// const WebSocketServer = ws.WebSocketServer || ws.Server;

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

// Store authenticated WebSocket connections with their user IDs - NO LONGER NEEDED HERE
// const connections = new Map();

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

  // Initialize WebSocket server - OLD IMPLEMENTATION REMOVED
  // const wss = new WebSocketServer({
  // server,
  // path: '/api/ws',
  // verifyClient: (info, callback) => {
  // console.log(`[WebSocket Auth] Client connecting from origin: ${info.origin}`);
  // return callback(true);
  // }
  // });

  // Handle WebSocket connections - OLD IMPLEMENTATION REMOVED
  // wss.on('connection', (ws, req) => { ... });

  // Initialize the new WebSocket server from manager.ts
  initWebSocketServer(server);
  console.log('[Main Server] New WebSocket server initialized via manager.');


  // Export a function to send auth success messages - NO LONGER NEEDED HERE, handled by manager
  // global.sendAuthSuccess = (connectionId, token, userData) => { ... };

  // Handle server errors - OLD WSS ERRORS NO LONGER NEEDED HERE
  // wss.on('error', (error) => {
  // console.error("FATAL: WebSocketServer emitted error:", error);
  // });

  // Start the server
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const HOST = process.env.HOST || '0.0.0.0'; // Use 0.0.0.0 to listen on all interfaces
  server.listen(PORT, HOST, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://${HOST}:${PORT}`);
    // The new manager should log its own WebSocket path
    // console.log(`> WebSocket server attached and listening on ws://${HOST}:${PORT}/api/ws`);
  });
});
