import axios from 'axios';
import { logUsage } from '../supabase/client';
import { sendGeminiRequest, GEMINI_MODELS } from './gemini-provider';
import { sendAnthropicRequest, ANTHROPIC_MODELS } from './anthropic-provider';

// Provider types
export type ApiProvider = 'openai' | 'anthropic' | 'groq' | 'mistral' | 'ollama' | 'custom' | 'gemini';

// Request/response types
export type LLMRequestParams = {
  provider: ApiProvider;
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  userId: string;
};

export type LLMResponse = {
  text: string;
  tokensUsed: number;
  creditsUsed: number;
  toolCall?: {
    name: string;
    parameters: any;
    id: string;
  };
};

// Configuration for different providers
export const providerConfig = {
  openai: {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo'],
    tokenMultiplier: 1.0, // 1 token = 1 credit
  },
  anthropic: {
    apiUrl: 'https://api.anthropic.com/v1/messages',
    models: Object.keys(ANTHROPIC_MODELS),
    tokenMultiplier: 1.0, // Varies by model, handled in anthropic-provider.ts
  },
  groq: {
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    models: ['llama3-70b-8192', 'mixtral-8x7b-32768'],
    tokenMultiplier: 0.5, // 1 token = 0.5 credits
  },
  mistral: {
    apiUrl: 'https://api.mistral.ai/v1/chat/completions',
    models: ['mistral-large', 'mistral-medium', 'mistral-small'],
    tokenMultiplier: 0.7, // 1 token = 0.7 credits
  },
  gemini: {
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: Object.keys(GEMINI_MODELS),
    tokenMultiplier: 1.0, // Varies by model, handled in gemini-provider.ts
  },
  ollama: {
    apiUrl: 'http://localhost:11434/api/chat',
    models: ['llama3', 'mistral'],
    tokenMultiplier: 0.1, // 1 token = 0.1 credits (local models are cheaper)
  },
  custom: {
    apiUrl: '',
    models: ['custom-model'],
    tokenMultiplier: 1.0,
  },
};

// Map to store API keys for each provider
const apiKeys: Record<ApiProvider, string | null> = {
  openai: process.env.OPENAI_API_KEY || null,
  anthropic: process.env.ANTHROPIC_API_KEY || null,
  groq: process.env.GROQ_API_KEY || null,
  mistral: process.env.MISTRAL_API_KEY || null,
  gemini: process.env.GEMINI_API_KEY || null,
  ollama: null, // Local, doesn't need API key
  custom: process.env.CUSTOM_API_KEY || null,
};

// Estimate token count (very rough estimate)
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Send a request to an LLM provider
 */
export async function sendLLMRequest({
  provider,
  model,
  prompt,
  temperature = 0.7,
  maxTokens = 2048,
  userId,
}: LLMRequestParams): Promise<LLMResponse> {
  // Get provider configuration
  const config = providerConfig[provider];
  if (!config) {
    throw new Error(`Provider ${provider} not supported`);
  }

  // Check if model is supported
  if (!config.models.includes(model)) {
    throw new Error(`Model ${model} not supported for provider ${provider}`);
  }

  // Check if we have an API key
  const apiKey = apiKeys[provider];
  if (!apiKey && provider !== 'ollama') {
    throw new Error(`API key for ${provider} not configured`);
  }

  // Build request based on provider
  let response;
  let tokensUsed = 0;

  try {
    // Format the request based on the provider
    switch (provider) {
      case 'gemini':
        // Use the dedicated Gemini implementation
        const geminiResponse = await sendGeminiRequest({
          apiKey: apiKey!,
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          maxTokens,
        });

        // Log usage to database
        await logUsage({
          user_id: userId,
          provider,
          model,
          tokens_used: geminiResponse.tokensUsed,
          credits_used: geminiResponse.creditsUsed,
        });

        return geminiResponse;

      case 'openai':
        response = await axios.post(
          config.apiUrl,
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
          }
        );
        tokensUsed = response.data.usage.total_tokens;
        break;

      case 'anthropic':
        // Use the dedicated Anthropic implementation
        const anthropicResponse = await sendAnthropicRequest({
          apiKey: apiKey!,
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          maxTokens,
        });

        // Log usage to database
        await logUsage({
          user_id: userId,
          provider,
          model,
          tokens_used: anthropicResponse.tokensUsed,
          credits_used: anthropicResponse.creditsUsed,
        });

        return anthropicResponse;

      case 'groq':
        response = await axios.post(
          config.apiUrl,
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
          }
        );
        tokensUsed = response.data.usage.total_tokens;
        break;

      case 'mistral':
        response = await axios.post(
          config.apiUrl,
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
          }
        );
        tokensUsed = response.data.usage.total_tokens;
        break;

      case 'ollama':
        response = await axios.post(
          config.apiUrl,
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            options: {
              temperature,
            },
          }
        );
        // Ollama doesn't return token count, so estimate
        tokensUsed = estimateTokenCount(prompt) + estimateTokenCount(response.data.message.content);
        break;

      case 'custom':
        // Implement your custom provider logic here
        throw new Error('Custom provider not implemented');

      default:
        throw new Error(`Provider ${provider} not implemented`);
    }

    // Calculate credit cost
    const creditsUsed = Math.ceil(tokensUsed * config.tokenMultiplier);

    // Extract the response text based on provider
    let responseText = '';
    switch (provider) {
      case 'openai':
      case 'groq':
      case 'mistral':
        responseText = response.data.choices[0].message.content;
        break;
      // Anthropic is handled separately above
      case 'ollama':
        responseText = response.data.message.content;
        break;
      // Gemini is handled separately above
    }

    // Log usage to database
    await logUsage({
      user_id: userId,
      provider,
      model,
      tokens_used: tokensUsed,
      credits_used: creditsUsed,
    });

    return {
      text: responseText,
      tokensUsed,
      creditsUsed,
    };

  } catch (error) {
    console.error('Error sending LLM request:', error);
    throw error;
  }
}

/**
 * Update API key for a provider
 */
export function setProviderApiKey(provider: ApiProvider, key: string): void {
  // Since apiKeys is const, use a different approach to update
  Object.defineProperty(apiKeys, provider, {
    value: key,
    writable: true,
    configurable: true
  });
}

/**
 * Get available models for a provider
 */
export function getProviderModels(provider: ApiProvider): string[] {
  return providerConfig[provider]?.models || [];
}

/**
 * Check if a provider is configured with an API key
 */
export function isProviderConfigured(provider: ApiProvider): boolean {
  return provider === 'ollama' || Boolean(apiKeys[provider]);
}