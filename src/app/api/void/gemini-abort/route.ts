import { NextRequest } from 'next/server';
import { createCorsResponse } from '../../../../lib/api-utils';
import { logger } from '../../../../lib/logger';

/**
 * Handle OPTIONS requests for CORS preflight
 */
export async function OPTIONS() {
  return createCorsResponse({}, 200);
}

/**
 * Abort endpoint for Gemini requests
 * This endpoint allows clients to abort ongoing Gemini requests
 */
export async function POST(req: NextRequest) {
  try {
    // Parse request body
    const body = await req.json();
    const { requestId } = body;

    if (!requestId) {
      logger.warn('Invalid abort request: missing requestId');
      return createCorsResponse(
        { error: 'Invalid request', message: 'Missing requestId' },
        400
      );
    }

    logger.info(`Received abort request for Gemini request ${requestId}`);

    // In a real implementation, you would track active requests and abort them
    // For now, we'll just acknowledge the abort request

    return createCorsResponse(
      { success: true, message: `Abort request received for ${requestId}` },
      200
    );
  } catch (error) {
    logger.error('Error in Gemini abort API:', error);
    
    return createCorsResponse(
      { error: 'Internal server error', message: (error as Error).message },
      500
    );
  }
}
