import { NextRequest } from 'next/server';
import { handleClientRequest } from '../../../../lib/ai-providers/client-api';
import { createCorsResponse } from '../../../../lib/api-utils';

/**
 * API endpoint for handling LLM messages from the Void client
 * This endpoint mimics the behavior of the client-side LLM message service
 * but routes requests through the server for authentication, credit tracking, etc.
 */
export async function POST(req: NextRequest) {
  try {
    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
      return createCorsResponse({}, 200);
    }
    
    // Process the request
    return await handleClientRequest(req);
  } catch (error) {
    console.error('Error in LLM message API:', error);
    return createCorsResponse(
      { error: 'Internal server error', message: (error as Error).message },
      500
    );
  }
}

/**
 * Handle model listing requests
 */
export async function GET(req: NextRequest) {
  try {
    // This could be expanded to fetch from a database or filter based on the user's plan
    const providers = {
      openai: ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo'],
      anthropic: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
      groq: ['llama3-70b-8192', 'mixtral-8x7b-32768'],
      mistral: ['mistral-large', 'mistral-medium', 'mistral-small'],
    };

    return createCorsResponse({ providers });
  } catch (error) {
    console.error('Error fetching providers:', error);
    
    return createCorsResponse(
      { error: 'Internal server error', message: (error as Error).message },
      500
    );
  }
}
