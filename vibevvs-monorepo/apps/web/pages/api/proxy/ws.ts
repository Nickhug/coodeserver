// Direct TCP/WebSocket proxy for Railway internal networking
import { NextApiRequest, NextApiResponse } from 'next';
import { createServer } from 'http';
import { Socket } from 'net';
import logger from '@repo/logger';

// Disable body parsing for WebSockets
export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

// Railway internal networking target
const WS_HOST = process.env.INTERNAL_WS_HOST || 'ws-server.railway.internal';
const WS_PORT = parseInt(process.env.INTERNAL_WS_PORT || '3001', 10);
const WS_PATH = process.env.INTERNAL_WS_PATH || '/ws';
const TARGET = `http://${WS_HOST}:${WS_PORT}${WS_PATH}`;

// Log the configuration
logger.info(`[WS_PROXY] Direct TCP proxy to ${TARGET}`);

/**
 * Simple proxy that directly forwards the TCP connection
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // For non-WebSocket requests
  if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() !== 'websocket') {
    logger.info(`[WS_PROXY] Non-WebSocket request received: ${req.method} ${req.url}`);
    return res.status(426).json({
      error: 'Upgrade Required',
      message: 'This endpoint is for WebSocket connections only'
    });
  }
  
  // For WebSocket requests, we need to handle the upgrade
  logger.info(`[WS_PROXY] WebSocket request received: ${req.url}`);
  
  // Create a direct TCP connection to the target WebSocket server
  try {
    // Get the socket from the response
    const clientSocket = res.socket;
    if (!clientSocket) {
      logger.error('[WS_PROXY] No client socket found');
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    logger.info(`[WS_PROXY] Creating direct TCP connection to ${WS_HOST}:${WS_PORT}`);
    
    // Create a TCP connection to the WebSocket server
    const serverSocket = new Socket();
    
    // Handle errors on the server socket
    serverSocket.on('error', (err) => {
      logger.error(`[WS_PROXY] Server socket error: ${err.message}`);
      clientSocket.end();
    });
    
    // Handle errors on the client socket
    clientSocket.on('error', (err) => {
      logger.error(`[WS_PROXY] Client socket error: ${err.message}`);
      serverSocket.end();
    });
    
    // Forward data from server to client
    serverSocket.on('data', (data) => {
      clientSocket.write(data);
    });
    
    // Forward data from client to server
    clientSocket.on('data', (data) => {
      serverSocket.write(data);
    });
    
    // Handle connection close
    serverSocket.on('close', () => {
      logger.info('[WS_PROXY] Server socket closed');
      clientSocket.end();
    });
    
    clientSocket.on('close', () => {
      logger.info('[WS_PROXY] Client socket closed');
      serverSocket.end();
    });
    
    // Connect to the target server
    serverSocket.connect(WS_PORT, WS_HOST, () => {
      logger.info(`[WS_PROXY] Connected to ${WS_HOST}:${WS_PORT}`);
      
      // Send the WebSocket upgrade headers to the server
      const headers = [
        `GET ${WS_PATH} HTTP/1.1`,
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}`,
        `Origin: http://${WS_HOST}:${WS_PORT}`,
        '',
        ''
      ].join('\r\n');
      
      // Send the headers to the server
      serverSocket.write(headers);
    });
    
    // This is a hack to prevent Next.js from closing the connection
    // We need to keep the response alive but not send anything
    res.writeHead(101);
    res.socket?.on('close', () => {
      logger.info('[WS_PROXY] Response socket closed');
    });
    
  } catch (error) {
    logger.error(`[WS_PROXY] Error: ${(error as Error).message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'WebSocket proxy error' });
    }
  }
} 