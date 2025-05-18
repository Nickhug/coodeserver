import { createProxyMiddleware } from 'http-proxy-middleware';
import { NextApiRequest, NextApiResponse } from 'next';
import logger from '@repo/logger';
import http from 'http';
import net from 'net';

// We need to disable the default body parser for raw WebSocket connections
export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

// Define an extended error interface that includes a code property
interface NetworkError extends Error {
  code?: string;
}

// The WebSocket server connection details - use Railway's internal networking
const WS_INTERNAL_HOST = process.env.INTERNAL_WS_HOST || 'ws-server'; // Railway internal service name (no .railway.internal suffix needed)
const WS_INTERNAL_PORT = process.env.INTERNAL_WS_PORT || '3001'; // Port your ws-server listens on
const TARGET_WS_URL = `http://${WS_INTERNAL_HOST}:${WS_INTERNAL_PORT}`; // Use http:// protocol for the proxy target

logger.info(`[WS_PROXY] Initialized. Target WebSocket URL: ${TARGET_WS_URL}`);

const proxy = createProxyMiddleware({
  target: TARGET_WS_URL,
  ws: true,
  changeOrigin: true,
  pathRewrite: { '^/api/ws': '' }, // Remove the /api/ws prefix when forwarding
  
  // Logger configuration - http-proxy-middleware v3 uses a different approach
  logger,

  // Error handler
  on: {
    error: (err: NetworkError, req: http.IncomingMessage, res: http.ServerResponse | net.Socket) => {
      logger.error(`[WS_PROXY] Error during proxying: ${err.message}`, {
        errorCode: err.code,
        target: TARGET_WS_URL,
        url: req.url,
      });

      // Handle HTTP response errors
      if (res instanceof http.ServerResponse && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'WebSocket proxy error', 
          message: err.message,
          code: err.code 
        }));
      }
    },
    // Optional: Add other event handlers if needed
    proxyReq: (proxyReq, req) => {
      logger.debug(`[WS_PROXY] Proxying request: ${req.method} ${req.url}`);
    },
    proxyRes: (proxyRes, req) => {
      logger.debug(`[WS_PROXY] Received response: ${proxyRes.statusCode} for ${req.url}`);
    }
  }
});

// Main handler for Next.js API route
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  logger.info(`[WS_PROXY] Request: ${req.method} ${req.url}`);
  
  // Pass to proxy middleware and let it handle both HTTP and WS upgrade requests
  // @ts-ignore - type mismatch in http-proxy-middleware but works at runtime
  return proxy(req, res);
}

// Graceful shutdown for the proxy (optional, but good practice)
process.on('SIGTERM', () => {
  logger.info('[WS_PROXY] SIGTERM signal received. Closing proxy server.');
  // @ts-ignore
  if (proxy && proxy.close) {
    // @ts-ignore
    proxy.close(() => {
      logger.info('[WS_PROXY] Proxy server closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});