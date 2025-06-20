/**
 * AI Providers Package
 * Contains implementations for different AI providers (Gemini, OpenAI, etc.)
 */
import { ToolCall } from '@repo/types';
import logger from '@repo/logger';

// Re-export provider implementations
export * from './gemini';

// Common interfaces for LLM responses
export interface LLMResponse {
  text: string;
  tokensUsed?: number;
  creditsUsed?: number;
  success?: boolean;
  error?: string;
  generatedText?: string;
  tool_calls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  waitingForToolCall?: boolean;
  rawResponse?: any; // Optional field for the raw response from the provider
  reasoning?: string; // Optional field for reasoning/thought process leading to a tool call or final answer
  finish_reason?: string;
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

// Dynamic provider functions
export async function getGeminiProvider(apiKey?: string): Promise<Provider | null> {
  if (!apiKey) return null;
  
  try {
    const gemini = await import('./gemini');
    const models = await gemini.listModels(apiKey);
    
    return {
      id: 'gemini',
      name: 'Google Gemini',
      available: true,
      models
    };
  } catch (error) {
    logger.error('Failed to load Gemini provider:', error);
    return null;
  }
}

export async function getMistralProvider(apiKey?: string): Promise<Provider | null> {
  if (!apiKey) return null;
  
  try {
    // Import mistral from the server directory since it's not in this package
    // This will need to be handled differently in the actual implementation
    return {
      id: 'mistral',
      name: 'Mistral AI',
      available: true,
      models: [] // Will be populated by server-side mistral.listModels()
    };
  } catch (error) {
    logger.error('Failed to load Mistral provider:', error);
    return null;
  }
}

// Dynamic providers list function
export async function getAvailableProviders(apiKeys: {
  gemini?: string;
  mistral?: string;
  openai?: string;
  groq?: string;
}): Promise<Provider[]> {
  const providers: Provider[] = [];
  
  // Add Gemini if API key is available
  if (apiKeys.gemini) {
    const geminiProvider = await getGeminiProvider(apiKeys.gemini);
    if (geminiProvider) providers.push(geminiProvider);
  }
  
  // Add other providers as they become available
  // Note: Mistral, OpenAI, and Groq would need similar implementations
  
  return providers;
}

// Legacy static providers list (kept for backward compatibility)
export const providers: Provider[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    available: false, // Will be determined dynamically
    models: [] // Will be populated dynamically
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
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
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
        return await gemini.sendGeminiMessage({
          apiKey,
          model,
          messages: [{ role: 'user', parts: [{ text: prompt }] }],
          temperature,
          maxTokens,
        });

      // Add other providers as they are implemented
      
      default:
        return {
          text: '',
          tokensUsed: 0,
          success: false,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          error: `Unsupported provider: ${provider}`,
        };
    }
  } catch (error) {
    logger.error(`Error in LLM request:`, error);
    return {
      text: '',
      tokensUsed: 0,
      success: false,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}