// Simple WebSocket proxy for Railway internal networking
import { NextApiRequest, NextApiResponse } from 'next';
import { Server } from 'http';
import { Socket } from 'net';
import logger from '@repo/logger';

// Config for WebSocket (disable body parsing)
export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

// Railway private networking target
const WS_HOST = process.env.INTERNAL_WS_HOST || 'ws-server.railway.internal';
const WS_PORT = process.env.INTERNAL_WS_PORT || '3001';
const WS_PATH = process.env.INTERNAL_WS_PATH || '/ws';
const TARGET = `http://${WS_HOST}:${WS_PORT}${WS_PATH}`;

// Log configuration on startup
logger.info(`[WS_PROXY] WebSocket proxy configured with target: ${TARGET}`);

/**
 * This is a very basic proxy handler for WebSockets
 * It handles the upgrade and forwards the connection to the internal service
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const { socket } = res;
  
  // This is a hack to access the raw Node.js server instance
  const server = (res as any).socket.server as Server;
  
  // Log the incoming request
  logger.info(`[WS_PROXY] Handling ${req.method} request to ${req.url}`);
  
  if (req.method === 'GET') {
    // For WebSocket upgrade requests
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
      logger.info(`[WS_PROXY] WebSocket upgrade request detected`);
      
      // Get the upgrade handler from the server
      const upgradeHandler = server.listeners('upgrade')[0];
      
      // Add special route header for the upgrade handler to identify this route
      req.headers['x-forwarded-host'] = WS_HOST;
      req.headers['x-forwarded-port'] = WS_PORT;
      req.headers['x-forwarded-path'] = WS_PATH;
      req.headers['x-railway-internal'] = 'true';
      
      // Let the upgrade handler do its work
      upgradeHandler(req, socket as Socket, Buffer.alloc(0));
      
      // Return here, the upgrade will be handled
      return;
    }
    
    // For regular HTTP requests to this endpoint
    res.status(426).json({ 
      error: 'Upgrade Required',
      message: 'This endpoint is for WebSocket connections only'
    });
    return;
  }
  
  // Reject non-GET requests
  res.status(405).json({ 
    error: 'Method Not Allowed',
    message: 'Only GET requests are allowed'
  });
} 