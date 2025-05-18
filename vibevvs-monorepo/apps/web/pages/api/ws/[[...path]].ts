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
const WS_INTERNAL_PORT = process.env.INTERNAL_WS_PORT || '3001'; // Port your ws-server listens on
const TARGET_WS_URL = `ws://${WS_INTERNAL_HOST}:${WS_INTERNAL_PORT}`;

logger.info(`[WS_PROXY] Initialized. Target WebSocket URL: ${TARGET_WS_URL}`);

const proxy = createProxyMiddleware({
  target: TARGET_WS_URL,
  ws: true, // Enable WebSocket proxying
  changeOrigin: true, // Recommended for virtual hosted sites
  logLevel: 'debug', // Enable detailed proxy logging
  logProvider: () => logger, // Use our custom logger

  onProxyReqWs: (proxyReq, req, socket, options, head) => {
    logger.info(`[WS_PROXY] Client -> Proxy -> Target: Upgrading to WebSocket for ${req.url}`);
    logger.debug(`[WS_PROXY] Original client headers: ${JSON.stringify(req.headers, null, 2)}`);

    // Ensure critical WebSocket headers are present and preserved
    // http-proxy-middleware usually handles these, but being explicit can help in complex setups
    const requiredHeaders = {
      'connection': req.headers.connection || 'Upgrade',
      'upgrade': req.headers.upgrade || 'websocket',
      'sec-websocket-key': req.headers['sec-websocket-key'],
      'sec-websocket-version': req.headers['sec-websocket-version'],
      'sec-websocket-protocol': req.headers['sec-websocket-protocol'],
      'sec-websocket-extensions': req.headers['sec-websocket-extensions'],
    };

    for (const [key, value] of Object.entries(requiredHeaders)) {
      if (value) {
        proxyReq.setHeader(key, value);
      } else if (key === 'sec-websocket-key') { // sec-websocket-key is mandatory
        logger.warn(`[WS_PROXY] Missing mandatory 'sec-websocket-key' header from client. This will likely fail.`);
      }
    }
    
    // Forward 'x-forwarded-for' and 'x-real-ip' if present
    if (req.headers['x-forwarded-for']) {
      proxyReq.setHeader('x-forwarded-for', req.headers['x-forwarded-for']);
    }
    if (req.headers['x-real-ip']) {
      proxyReq.setHeader('x-real-ip', req.headers['x-real-ip']);
    }

    logger.debug(`[WS_PROXY] Proxy request headers to target: ${JSON.stringify(proxyReq.getHeaders(), null, 2)}`);
  },

  onOpen: (proxySocket) => {
    logger.info('[WS_PROXY] Target -> Proxy: WebSocket connection opened with target server.');
    proxySocket.on('data', (data) => {
      logger.debug(`[WS_PROXY] Target -> Proxy -> Client: Data received from target: ${data.toString().substring(0, 100)}...`);
    });
    proxySocket.on('error', (err: NetworkError) => {
        logger.error(`[WS_PROXY] Target -> Proxy: Error on WebSocket connection to target: ${err.message}`, { code: err.code });
    });
     proxySocket.on('close', (hadError) => {
      logger.info(`[WS_PROXY] Target -> Proxy: WebSocket connection to target closed. Had error: ${hadError}`);
    });
  },

  onProxyRes: (proxyRes, req, res) => {
    logger.info(`[WS_PROXY] Target -> Proxy -> Client: Received HTTP response from target for ${req.url}`, { statusCode: proxyRes.statusCode });
    logger.debug(`[WS_PROXY] Target response headers: ${JSON.stringify(proxyRes.headers, null, 2)}`);
  },
  
  onError: (err: NetworkError, req, res, target) => {
    logger.error(`[WS_PROXY] Error during proxying for ${req.url} to ${target}. Error: ${err.message}`, {
      errorCode: err.code,
      requestHeaders: req.headers,
    });

    // Ensure response is properly handled for WebSocket upgrade errors vs. HTTP errors
    if (res && typeof res.writeHead === 'function') {
      if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
        // If it was a WebSocket upgrade attempt, the socket might already be ended or taken over.
        // Trying to writeHead or end might throw.
        logger.warn('[WS_PROXY] Error occurred during WebSocket upgrade attempt. Client socket might be closed.');
        if (res.socket && !res.socket.destroyed) {
           res.socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
      } else if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy Error: Could not connect to WebSocket target.');
      }
    } else if (res && res.socket && !res.socket.destroyed) {
        // Fallback for when res is not a standard ServerResponse (e.g., already a socket)
        res.socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
  },
  
  onClose: (req, socket, head) => {
    logger.info(`[WS_PROXY] Client -> Proxy: WebSocket connection closed by client for ${req.url}`);
  },
});

// Main handler for Next.js API route
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  logger.info(`[WS_PROXY] API Route /api/ws handling request: ${req.method} ${req.url}`);
  
  // Check if it's an upgrade request
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    logger.info(`[WS_PROXY] Detected WebSocket upgrade request for ${req.url}. Passing to http-proxy-middleware.`);
    
    // @ts-ignore
    return proxy(req, res);
  } else {
    // Handle regular HTTP requests to this endpoint if necessary, or return an error
    logger.warn(`[WS_PROXY] Received non-WebSocket request to ${req.url}: ${req.method}. This endpoint is for WebSockets only.`);
    res.status(400).json({ message: 'This endpoint is for WebSocket connections only.' });
  }
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