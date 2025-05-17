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

// The internal WebSocket server URL - this should be the Railway internal service name
const INTERNAL_WS_SERVER = 'happy-cooperation.railway.internal';

// This handler will proxy both regular HTTP requests and WebSocket upgrade requests
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Log the attempt to connect
  logger.info(`WebSocket proxy request received: ${req.url} to ${INTERNAL_WS_SERVER}`);
  
  // Create proxy for each request
  const proxy = createProxyMiddleware({
    target: `http://${INTERNAL_WS_SERVER}`,
    ws: true, // Enable WebSocket proxying
    changeOrigin: true,
    secure: false, // Don't verify SSL certificates for internal Railway services
    pathRewrite: {
      '^/api/ws': '/ws', // Rewrite to the correct path on the internal service
    },
  });
  
  return new Promise<void>((resolve, reject) => {
    try {
      // @ts-ignore - Type mismatch between Next.js and http-proxy-middleware
      proxy(req, res, (result: unknown) => {
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