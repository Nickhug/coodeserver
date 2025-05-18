import { NextApiRequest, NextApiResponse } from 'next';
import logger from '@repo/logger';

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  logger.info(`[WS_PROXY_TEST] Received request to /api/ws: ${req.url}`, {
    method: req.method,
    headers: req.headers,
  });

  if (req.method === 'GET') {
    res.status(200).json({ message: 'Test handler for /api/ws is active', success: true });
  } else {
    res.status(405).json({ message: 'Method Not Allowed', success: false });
  }
}