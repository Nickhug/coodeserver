/**
 * AI Providers Package
 * Contains implementations for different AI providers (Gemini, OpenAI, etc.)
 */
import logger from '@repo/logger';

// Re-export provider implementations
export * from './gemini';

// Common interfaces for LLM responses
export interface LLMResponse {
  text: string;
  tokensUsed: number;
  creditsUsed?: number;
  success: boolean;
  error?: string;
  generatedText?: string;
  toolCall?: {
    name: string;
    parameters: Record<string, unknown>;
    id: string;
  };
  waitingForToolCall?: boolean;
}

// Message types
export interface LLMMessage {
  role: string;
  content: string;
}

// Provider model interfaces
export interface ProviderModel {
  id: string;
  name: string;
  provider: string;
  available: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  features?: string[];
}

export interface Provider {
  id: string;
  name: string;
  available: boolean;
  models: ProviderModel[];
}

// List of available providers
export const providers: Provider[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    available: true,
    models: [
      {
        id: 'gemini-1.5-flash',
        name: 'Gemini 1.5 Flash',
        provider: 'gemini',
        available: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 8_192,
        features: ['text', 'code', 'vision', 'tools']
      },
      {
        id: 'gemini-1.5-pro',
        name: 'Gemini 1.5 Pro',
        provider: 'gemini',
        available: true,
        contextWindow: 2_097_152,
        maxOutputTokens: 8_192,
        features: ['text', 'code', 'vision', 'tools']
      }
    ]
  }
];

// Utility function to get provider by ID
export function getProvider(providerId: string): Provider | undefined {
  return providers.find(p => p.id === providerId);
}

// Utility function to get model by provider and model ID
export function getModel(providerId: string, modelId: string): ProviderModel | undefined {
  const provider = getProvider(providerId);
  if (!provider) return undefined;
  return provider.models.find(m => m.id === modelId);
}

// Common types
export type ApiProvider = 'openai' | 'groq' | 'mistral' | 'gemini';

export interface LLMRequestParams {
  provider: ApiProvider;
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
  userId?: string;
}

/**
 * Send a request to an LLM provider
 */
export async function sendLLMRequest(params: LLMRequestParams): Promise<LLMResponse> {
  const { provider, model, prompt, temperature, maxTokens, apiKey } = params;

  if (!apiKey) {
    logger.error(`No API key provided for ${provider}`);
    return {
      text: '',
      tokensUsed: 0,
      success: false,
      error: `No API key provided for ${provider}`,
    };
  }

  logger.info(`Sending request to ${provider} using model ${model}`);

  try {
    // Route the request to the appropriate provider
    switch (provider) {
      case 'gemini':
        // Import here to avoid circular dependencies
        const gemini = await import('./gemini');
        return await gemini.sendRequest({
          apiKey,
          model,
          prompt,
          temperature,
          maxTokens,
        });
        
      // Add other providers as they are implemented
      
      default:
        return {
          text: '',
          tokensUsed: 0,
          success: false,
          error: `Unsupported provider: ${provider}`,
        };
    }
  } catch (error) {
    logger.error(`Error in LLM request:`, error);
    return {
      text: '',
      tokensUsed: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
} 