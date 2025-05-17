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
    host: WS_INTERNAL_HOST,
    port: WS_INTERNAL_PORT,
    path: WS_INTERNAL_PATH,
    env: process.env.NODE_ENV,
  });

  // Check if this is a WebSocket upgrade request
  const isUpgradeRequest = req.headers.upgrade?.toLowerCase() === 'websocket';
  logger.info(`[WS_PROXY] Is WebSocket upgrade request: ${isUpgradeRequest}`, {
    upgrade: req.headers.upgrade,
  });

  // Test connectivity to the internal WebSocket host
  // This can help determine if the issue is with network connectivity
  const testSocket = new net.Socket();
  const tcpConnectTimeout = setTimeout(() => {
    logger.error(`[WS_PROXY] TCP connection timeout to ${WS_INTERNAL_HOST}:${WS_INTERNAL_PORT}`);
    testSocket.destroy();
  }, 3000);

  testSocket.on('connect', () => {
    logger.info(`[WS_PROXY] TCP connection successful to ${WS_INTERNAL_HOST}:${WS_INTERNAL_PORT}`);
    clearTimeout(tcpConnectTimeout);
    testSocket.destroy();
  });

  testSocket.on('error', (err: NetworkError) => {
    logger.error(`[WS_PROXY] TCP connection error to ${WS_INTERNAL_HOST}:${WS_INTERNAL_PORT}:`, {
      error: err.message,
      code: err.code,
    });
    clearTimeout(tcpConnectTimeout);
  });

  // Test TCP connection to target
  testSocket.connect(WS_INTERNAL_PORT, WS_INTERNAL_HOST);
  
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
        headers: proxyReq.getHeaders(),
      });
    },
    onError: (err: NetworkError, req: NextApiRequest, res: NextApiResponse) => {
      logger.error(`[WS_PROXY] Proxy error: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        url: req.url,
        code: err.code,
      });
      
      if (!res.headersSent) {
        res.status(502).json({ 
          error: `WebSocket proxy error: ${err.message}`,
          code: err.code,
          host: WS_INTERNAL_HOST,
          port: WS_INTERNAL_PORT,
        });
      }
    },
    onProxyReqWs: (proxyReq: any, req: any, socket: any) => {
      logger.info(`[WS_PROXY] WebSocket upgrade request proxied to: ${WS_INTERNAL_HOST}:${WS_INTERNAL_PORT}${WS_INTERNAL_PATH}`, {
        headers: proxyReq.getHeaders(),
      });
    },
    onOpen: (proxySocket: any) => {
      logger.info('[WS_PROXY] WebSocket connection opened successfully');
      
      // Monitor socket events for better debugging
      proxySocket.on('data', (data: Buffer) => {
        logger.debug(`[WS_PROXY] WebSocket data received (${data.length} bytes)`);
      });
      
      proxySocket.on('error', (err: Error) => {
        logger.error(`[WS_PROXY] WebSocket socket error: ${err.message}`);
      });
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
          const networkError = result as NetworkError;
          logger.error(`[WS_PROXY] Proxy error in callback: ${networkError.message}`, {
            error: networkError.message,
            stack: networkError.stack,
            url: req.url,
            code: networkError.code,
          });
          
          if (!res.headersSent) {
            res.status(502).json({ 
              error: `WebSocket proxy error: ${networkError.message}`,
              code: networkError.code,
              host: WS_INTERNAL_HOST,
              port: WS_INTERNAL_PORT,
            });
          }
          
          return reject(result);
        }
        
        logger.info('[WS_PROXY] Proxy completed successfully');
        resolve();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      const errorCode = (error as NetworkError).code;
      
      logger.error(`[WS_PROXY] Exception: ${errorMessage}`, {
        error,
        stack: errorStack,
        code: errorCode,
        url: req.url,
      });
      
      if (!res.headersSent) {
        res.status(500).json({ 
          error: 'WebSocket proxy exception',
          message: errorMessage,
          code: errorCode,
          host: WS_INTERNAL_HOST,
          port: WS_INTERNAL_PORT,
        });
      }
      
      reject(error);
    }
  });
}