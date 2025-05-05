import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserWithDb } from '../../../../lib/clerk/auth';
import { providerConfig } from '../../../../lib/ai-providers/providers';
import { GEMINI_MODELS } from '../../../../lib/ai-providers/gemini-provider';
import { logger } from '../../../../lib/logger';

// Define allowed origin for VVS
const ALLOWED_ORIGIN = 'vscode-file://vscode-app';

/**
 * Helper function to create a JSON response with CORS headers
 */
function createCorsResponse(body: object, status: number = 200) {
  return NextResponse.json(body, {
    status: status,
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Void-Session-Token',
    },
  });
}

/**
 * API endpoint to list models available on the server
 * This allows clients to use server-provided models without needing their own API keys
 */
export async function GET(req: NextRequest) {
  try {
    // Authenticate user - pass request to support custom token-based auth
    const userInfo = await getCurrentUserWithDb(req);
    if (!userInfo) {
      // Log the headers for debugging
      const headers = Object.fromEntries(req.headers.entries());
      logger.warn('Unauthorized access attempt to server-models endpoint', {
        headers: JSON.stringify(headers, null, 2),
        cookies: req.cookies.toString()
      });

      return createCorsResponse(
        { error: 'Unauthorized' },
        401
      );
    }

    // Log successful authentication
    logger.info(`Authenticated user accessing server-models endpoint: ${userInfo.dbUser.id}`);

    // Get available providers and their models
    const availableProviders: Record<string, {
      models: string[],
      requiresApiKey: boolean,
      modelDetails?: Array<{
        name: string,
        contextWindow?: number,
        maxTokens?: number,
        tokenMultiplier?: number
      }>
    }> = {};

    // Check which providers have API keys configured on the server
    for (const [provider, config] of Object.entries(providerConfig)) {
      const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
      const hasApiKey = !!apiKey;

      // Only include providers that have API keys configured
      if (hasApiKey) {
        availableProviders[provider] = {
          models: config.models,
          requiresApiKey: false // Server provides the API key
        };
      }
    }

    // Special handling for Gemini to include model details
    if (availableProviders['gemini']) {
      // Add detailed information about Gemini models
      const geminiModels = Object.keys(GEMINI_MODELS).map(modelName => {
        const model = GEMINI_MODELS[modelName as keyof typeof GEMINI_MODELS];
        return {
          name: modelName,
          contextWindow: model.contextWindow,
          maxTokens: model.maxOutputTokens,
          tokenMultiplier: model.tokenMultiplier
        };
      });

      availableProviders['gemini'] = {
        ...availableProviders['gemini'],
        models: Object.keys(GEMINI_MODELS),
        modelDetails: geminiModels
      };
    }

    logger.info(`Server models endpoint accessed by user ${userInfo.dbUser.id}`, {
      availableProviders: Object.keys(availableProviders)
    });

    // Return the list of available providers and models
    return createCorsResponse({
      providers: availableProviders
    });
  } catch (error) {
    logger.error('Error in server-models endpoint:', error);
    return createCorsResponse(
      { error: 'Internal server error' },
      500
    );
  }
}

/**
 * Handle OPTIONS requests for CORS preflight
 */
export async function OPTIONS() {
  return createCorsResponse({}, 200);
}
