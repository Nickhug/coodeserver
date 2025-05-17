import { NextRequest, NextResponse } from 'next/server';
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

// Setting up the proxy middleware
const wsProxy = createProxyMiddleware({
  target: process.env.NEXT_PUBLIC_WS_SERVER_URL || 'wss://coodeai.com/api/ws',
  ws: true, // Enable WebSocket proxying
  changeOrigin: true,
  pathRewrite: {
    '^/api/ws': '', // No need to append /ws as it's already in the target URL
  },
});

// This handler will proxy both regular HTTP requests and WebSocket upgrade requests
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Log the attempt to connect
  logger.info(`WebSocket proxy request received: ${req.url}`);
  
  return new Promise<void>((resolve, reject) => {
    try {
      // Forward the request to the proxy middleware
      wsProxy(req, res, (result: unknown) => {
        if (result instanceof Error) {
          logger.error(`WebSocket proxy error: ${result.message}`);
          
          // Only send error response if headers haven't been sent yet
          if (!res.headersSent) {
            res.status(500).json({ error: `WebSocket proxy error: ${result.message}` });
          }
          
          return reject(result);
        }
        resolve();
      });
    } catch (error) {
      logger.error(`WebSocket proxy exception: ${error instanceof Error ? error.message : String(error)}`);
      
      // Only send error response if headers haven't been sent yet
      if (!res.headersSent) {
        res.status(500).json({ error: 'WebSocket proxy exception' });
      }
      
      reject(error);
    }
  });
}