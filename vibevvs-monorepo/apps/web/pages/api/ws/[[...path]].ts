import { createProxyMiddleware } from 'http-proxy-middleware';
import { NextApiRequest, NextApiResponse } from 'next';
import logger from '@repo/logger';

// We need to disable the default body parser for raw WebSocket connections
export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

// The WebSocket server connection details - must match your Railway service exactly
const WS_INTERNAL_HOST = process.env.INTERNAL_WS_HOST || 'ws-server.railway.internal'; // Railway internal service name
const WS_INTERNAL_PORT = parseInt(process.env.INTERNAL_WS_PORT || '3001', 10); // Must match the WS_PORT env var on the ws-server service
const WS_INTERNAL_PATH = process.env.INTERNAL_WS_PATH || '/ws'; // Must match the WS_PATH env var on the ws-server service

// This handler will proxy both regular HTTP requests and WebSocket upgrade requests
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Log every connection attempt with better details
  logger.info(`[WS_PROXY] Received request: ${req.url}`, {
    headers: req.headers,
    method: req.method,
    url: req.url,
  });
  
  // IMPORTANT: Creating full target URL with explicit protocol/host/port
  const proxyOptions = {
    target: {
      protocol: 'http:',
      host: WS_INTERNAL_HOST,
      port: WS_INTERNAL_PORT,
    },
    ws: true, // Enable WebSocket proxying
    changeOrigin: true,
    secure: false, // Don't verify SSL for internal services
    pathRewrite: {
      '^/api/ws': WS_INTERNAL_PATH,
    },
    // Add connection timeout (5 seconds)
    timeout: 5000,
    // Log proxy activity for debugging
    onProxyReq: (proxyReq: any, req: any) => {
      logger.info(`[WS_PROXY] Proxying request to: ${WS_INTERNAL_HOST}:${WS_INTERNAL_PORT}${WS_INTERNAL_PATH}`, {
        method: req.method,
        url: req.url,
        target: `${WS_INTERNAL_HOST}:${WS_INTERNAL_PORT}${WS_INTERNAL_PATH}`,
      });
    },
    onError: (err: Error, req: NextApiRequest, res: NextApiResponse) => {
      logger.error(`[WS_PROXY] Proxy error: ${err.message}`, {
        error: err,
        url: req.url,
      });
      
      if (!res.headersSent) {
        res.status(502).json({ error: `WebSocket proxy error: ${err.message}` });
      }
    },
    onProxyReqWs: (proxyReq: any, req: any, socket: any) => {
      logger.info(`[WS_PROXY] WebSocket upgrade request proxied to: ${WS_INTERNAL_HOST}:${WS_INTERNAL_PORT}${WS_INTERNAL_PATH}`);
    },
    onOpen: (proxySocket: any) => {
      logger.info('[WS_PROXY] WebSocket connection opened successfully');
    },
    onClose: (res: any, socket: any, head: any) => {
      logger.info('[WS_PROXY] WebSocket connection closed');
    },
  };

  // Create proxy middleware with verbose options
  const proxy = createProxyMiddleware(proxyOptions);
  
  return new Promise<void>((resolve, reject) => {
    try {
      // @ts-ignore - Type mismatch between Next.js and http-proxy-middleware
      proxy(req, res, (result: unknown) => {
        if (result instanceof Error) {
          logger.error(`[WS_PROXY] Proxy error: ${result.message}`, {
            error: result,
            url: req.url,
          });
          
          if (!res.headersSent) {
            res.status(500).json({ error: `WebSocket proxy error: ${result.message}` });
          }
          
          return reject(result);
        }
        
        logger.info('[WS_PROXY] Proxy completed successfully');
        resolve();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[WS_PROXY] Exception: ${errorMessage}`, {
        error,
        url: req.url,
      });
      
      if (!res.headersSent) {
        res.status(500).json({ error: 'WebSocket proxy exception' });
      }
      
      reject(error);
    }
  });
}