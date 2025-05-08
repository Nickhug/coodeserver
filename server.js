import { ClerkExpressWithAuth } from '@clerk/clerk-sdk-node';
import express from 'express';
import http from 'http';
import next from 'next';
// Correctly import from the compiled websocket server manager
import { initWebSocketServer } from './websocket-server/dist/manager.js';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();
const port = process.env.PORT || 3000;

app.prepare().then(() => {
  const server = express();
  const httpServer = http.createServer(server);

  // Initialize WebSocket server and pass the HTTP server instance
  initWebSocketServer(httpServer)
    .then(() => {
      console.log('[Main Server] WebSocket server initialized successfully.');
    })
    .catch(err => {
      console.error('[Main Server] Failed to initialize WebSocket server:', err);
    });

  // Clerk authentication middleware
  // Make sure to place Clerk middleware before any routes that need authentication
  server.use(ClerkExpressWithAuth());

  // Handle all other Next.js requests
  server.all('* ', (req, res) => {
    return handle(req, res);
  });

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
