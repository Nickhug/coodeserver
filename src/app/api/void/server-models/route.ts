import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserWithDb } from '../../../../lib/clerk/auth';
import { providerConfig } from '../../../../lib/ai-providers/providers';
import { GEMINI_MODELS } from '../../../../lib/ai-providers/gemini-provider';
import { logger } from '../../../../lib/logger';

/**
 * API endpoint to list models available on the server
 * This allows clients to use server-provided models without needing their own API keys
 */
export async function GET(req: NextRequest) {
  try {
    // Authenticate user
    const userInfo = await getCurrentUserWithDb();
    if (!userInfo) {
      logger.warn('Unauthorized access attempt to server-models endpoint');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

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
    return NextResponse.json({
      providers: availableProviders
    });
  } catch (error) {
    logger.error('Error in server-models endpoint:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
