// Simple direct HTTP proxy to test Railway internal networking
import { NextApiRequest, NextApiResponse } from 'next';
import http from 'http';
import logger from '@repo/logger';

// Railway internal networking target
const WS_HOST = process.env.INTERNAL_WS_HOST || 'ws-server.railway.internal';
const WS_PORT = parseInt(process.env.INTERNAL_WS_PORT || '3001', 10);
const HEALTH_PATH = '/health';

// Define response type
interface ProxyResponse {
  status: string;
  error?: string;
  statusCode?: number;
  statusMessage?: string;
  rawResponse?: string;
  code?: string;
  [key: string]: any; // Allow additional properties
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  logger.info(`[HTTP_PROXY] Direct HTTP request to ${WS_HOST}:${WS_PORT}${HEALTH_PATH}`);
  
  try {
    // Make a direct HTTP request to the health endpoint
    const result = await new Promise<ProxyResponse>((resolve, reject) => {
      const request = http.request({
        host: WS_HOST,
        port: WS_PORT,
        path: HEALTH_PATH,
        method: 'GET',
        timeout: 5000, // 5 second timeout
      }, (response) => {
        let data = '';
        
        response.on('data', (chunk) => {
          data += chunk;
        });
        
        response.on('end', () => {
          logger.info(`[HTTP_PROXY] Received response: ${response.statusCode}`);
          
          if (response.statusCode === 200) {
            try {
              const jsonData = JSON.parse(data);
              resolve({ 
                status: 'success', 
                ...jsonData
              });
            } catch (err) {
              resolve({ 
                status: 'success',
                rawResponse: data,
                statusCode: response.statusCode
              });
            }
          } else {
            resolve({ 
              status: 'error',
              statusCode: response.statusCode,
              statusMessage: response.statusMessage
            });
          }
        });
      });
      
      request.on('error', (err) => {
        logger.error(`[HTTP_PROXY] Error: ${err.message}`);
        resolve({ 
          status: 'error',
          error: err.message,
          code: (err as any).code
        });
      });
      
      request.on('timeout', () => {
        logger.error('[HTTP_PROXY] Request timed out');
        request.destroy();
        resolve({ 
          status: 'error',
          error: 'Request timed out'
        });
      });
      
      request.end();
    });
    
    // Return the result
    return res.status(200).json({
      target: `${WS_HOST}:${WS_PORT}${HEALTH_PATH}`,
      result
    });
    
  } catch (error) {
    logger.error(`[HTTP_PROXY] Unexpected error: ${(error as Error).message}`);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: (error as Error).message 
    });
  }
} 