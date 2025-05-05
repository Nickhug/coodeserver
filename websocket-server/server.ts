import { createServer, Server } from 'http';
import { initWebSocketServer } from './manager';

const port = parseInt(process.env.PORT || '3001', 10);

// Create a simple HTTP server. The WebSocket server will attach to this.
const server: Server = createServer((req, res) => {
  // Basic response for root path, mainly for health checks
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket Server OK');
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(port, () => {
  console.log(`[WS Server] HTTP server listening on port ${port}`);
  // Initialize and attach the WebSocket server
  initWebSocketServer(server);
  console.log(`[WS Server] WebSocket server initialized and attached.`);
});

server.on('error', (error) => {
  console.error('[WS Server] HTTP Server error:', error);
  process.exit(1);
});

// Optional: Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('[WS Server] SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('[WS Server] HTTP server closed');
    // You might want to add WebSocket server cleanup here if needed
    process.exit(0);
  });
});
