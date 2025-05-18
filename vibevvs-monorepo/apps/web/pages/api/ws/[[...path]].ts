import { NextApiRequest, NextApiResponse } from 'next';
import logger from '@repo/logger';

// Disable body parsing for WebSocket
export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

// Handler function
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  logger.info(`[WS_REDIRECT] Redirecting WebSocket request to /api/proxy/ws`);
  
  // Redirect to the new proxy endpoint
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    // For WebSocket requests, we can't do a standard redirect
    // Instead, return a specific error that clients can handle
    res.status(307).json({
      error: 'WebSocket Endpoint Moved',
      message: 'The WebSocket endpoint has moved to /api/proxy/ws',
      newLocation: '/api/proxy/ws'
    });
  } else {
    // For normal HTTP requests, we can do a standard redirect
    res.redirect(307, '/api/proxy/ws');
  }
}