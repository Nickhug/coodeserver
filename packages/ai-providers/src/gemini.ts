import { GoogleGenerativeAI, GenerativeModel, GenerateContentStreamResult } from '@google/generative-ai';
import logger from '@repo/logger';
import { LLMResponse } from './index';

// Types for Gemini
export type GeminiModelName =
  | 'gemini-1.5-flash'
  | 'gemini-1.5-pro'
  | 'gemini-1.5-flash-8b'
  | 'gemini-2.5-flash-preview-04-17'
  | 'gemini-2.5-pro-exp-03-25'
  | 'gemini-2.5-pro-preview-03-25'
  | 'gemini-pro'
  | 'gemini-pro-vision';

export interface GeminiModelConfig {
  contextWindow: number;
  maxOutputTokens: number;
  tokenMultiplier: number;
}

export interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiMessage {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface SendGeminiRequestParams {
  apiKey: string;
  model: string;
  messages: GeminiMessage[];
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
  files?: { mimeType: string; data: string }[];
  tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[] | null;
  onStream?: ((text: string, toolCallUpdate?: { name: string; parameters: Record<string, unknown>; id?: string }) => void) | null;
}

// Define the available Gemini models
export const GEMINI_MODELS: Record<GeminiModelName, GeminiModelConfig> = {
  'gemini-1.5-flash': {
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    tokenMultiplier: 0.3, // 1 token = 0.3 credits
  },
  'gemini-1.5-pro': {
    contextWindow: 2_097_152,
    maxOutputTokens: 8_192,
    tokenMultiplier: 5.0, // 1 token = 5.0 credits
  },
  'gemini-1.5-flash-8b': {
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    tokenMultiplier: 0.15, // 1 token = 0.15 credits
  },
  'gemini-2.5-flash-preview-04-17': {
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    tokenMultiplier: 0.6, // 1 token = 0.6 credits
  },
  'gemini-2.5-pro-exp-03-25': {
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    tokenMultiplier: 0.0, // Free preview model
  },
  'gemini-2.5-pro-preview-03-25': {
    contextWindow: 2_097_152,
    maxOutputTokens: 8_192,
    tokenMultiplier: 0.0, // Free preview model
  },
  'gemini-pro': {
    contextWindow: 32_768,
    maxOutputTokens: 2_048,
    tokenMultiplier: 0.5, // 1 token = 0.5 credits
  },
  'gemini-pro-vision': {
    contextWindow: 16_384,
    maxOutputTokens: 2_048,
    tokenMultiplier: 1.0, // 1 token = 1.0 credits
  }
};

/**
 * Get the configuration for a Gemini model
 */
export function getModelConfig(model: string): GeminiModelConfig {
  return (
    GEMINI_MODELS[model as GeminiModelName] || {
      contextWindow: 1_048_576,
      maxOutputTokens: 8_192,
      tokenMultiplier: 1.0,
    }
  );
}

/**
 * Estimate token count for a string
 * This is a very rough estimate, as Gemini's tokenization is not publicly documented
 */
export function estimateTokenCount(text: string): number {
  // Rough estimate: 1 token ~= 4 characters
  return Math.ceil(text.length / 4);
}

interface GeminiRequestParams {
  apiKey: string;
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

interface GeminiStreamHandler {
  onStart?: () => void;
  onChunk: (chunk: string) => void;
  onError: (error: Error) => void;
  onComplete: (response: LLMResponse) => void;
}

/**
 * Create a Google Generative AI client
 */
function createGeminiClient(apiKey: string): GoogleGenerativeAI {
  return new GoogleGenerativeAI(apiKey);
}

/**
 * Get the appropriate Gemini model based on model name
 */
function getGeminiModel(client: GoogleGenerativeAI, modelName: string): GenerativeModel {
  return client.getGenerativeModel({ model: modelName });
}

/**
 * Convert a text prompt to Gemini content format
 */
function formatPrompt(prompt: string): any {
  return [
    {
      role: 'user',
      parts: [{ text: prompt }]
    }
  ];
}

/**
 * Send a request to the Gemini API
 */
export async function sendRequest(params: GeminiRequestParams): Promise<LLMResponse> {
  try {
    const { apiKey, model, prompt, temperature = 0.7, maxTokens } = params;
    
    logger.info(`Sending request to Gemini API with model: ${model}`);
    
    const client = createGeminiClient(apiKey);
    const geminiModel = getGeminiModel(client, model);
    
    const generationConfig: any = {
      temperature,
    };
    
    if (maxTokens) {
      generationConfig.maxOutputTokens = maxTokens;
    }
    
    // Format the prompt for Gemini
    const formattedPrompt = formatPrompt(prompt);
    
    // Send the request to Gemini
    const result = await geminiModel.generateContent({
      contents: formattedPrompt,
      generationConfig,
    });
    
    // Extract the response text
    const response = result.response;
    const text = response.text();
    
    // Estimate token usage (Google doesn't provide token counts directly)
    // This is a very rough estimate - characters / 4 is a common approximation
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(text.length / 4);
    const totalTokens = inputTokens + outputTokens;
    
    logger.info(`Gemini response received, estimated tokens: ${totalTokens}`);
    
    return {
      text,
      tokensUsed: totalTokens,
      creditsUsed: totalTokens / 1000, // Assuming 1000 tokens = 1 credit
      success: true,
      generatedText: text,
    };
  } catch (error) {
    logger.error('Error in Gemini request:', error);
    return {
      text: '',
      tokensUsed: 0,
      creditsUsed: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a streaming request to the Gemini API
 */
export async function sendStreamingRequest(
  params: GeminiRequestParams,
  handlers: GeminiStreamHandler
): Promise<void> {
  try {
    const { apiKey, model, prompt, temperature = 0.7, maxTokens } = params;
    
    logger.info(`Starting Gemini stream with model: ${model}`);
    
    const client = createGeminiClient(apiKey);
    const geminiModel = getGeminiModel(client, model);
    
    const generationConfig: any = {
      temperature,
    };
    
    if (maxTokens) {
      generationConfig.maxOutputTokens = maxTokens;
    }
    
    // Format the prompt for Gemini
    const formattedPrompt = formatPrompt(prompt);
    
    // Call onStart handler if provided
    if (handlers.onStart) {
      handlers.onStart();
    }
    
    // Send the streaming request
    const streamResult: GenerateContentStreamResult = await geminiModel.generateContentStream({
      contents: formattedPrompt,
      generationConfig,
    });
    
    let completeText = '';
    let startTime = Date.now();
    
    // Process the stream
    for await (const chunk of streamResult.stream) {
      const chunkText = chunk.text();
      completeText += chunkText;
      
      // Call onChunk handler for each chunk
      handlers.onChunk(chunkText);
    }
    
    // Calculate stream duration
    const duration = Date.now() - startTime;
    
    // Estimate token usage
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(completeText.length / 4);
    const totalTokens = inputTokens + outputTokens;
    
    logger.info(`Gemini stream completed in ${duration}ms, estimated tokens: ${totalTokens}`);
    
    // Call onComplete handler
    handlers.onComplete({
      text: completeText,
      tokensUsed: totalTokens,
      creditsUsed: totalTokens / 1000, // Assuming 1000 tokens = 1 credit
      success: true,
      generatedText: completeText,
    });
  } catch (error) {
    logger.error('Error in Gemini stream:', error);
    handlers.onError(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * List available Gemini models
 */
export async function listModels(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  try {
    // Google doesn't provide a direct API for listing models
    // Return a static list of commonly used models
    return [
      { id: 'gemini-pro', name: 'Gemini Pro' },
      { id: 'gemini-pro-vision', name: 'Gemini Pro Vision' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
    ];
  } catch (error) {
    logger.error('Error listing Gemini models:', error);
    return [];
  }
}

/**
 * Send a message to Gemini with streaming support
 * This is used by the WebSocket server to handle client requests
 */
export async function streamGeminiMessage(params: {
  apiKey: string;
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  onStart?: () => void;
  onChunk: (chunk: string) => void;
  onError: (error: Error) => void;
  onComplete: (response: LLMResponse) => void;
}): Promise<void> {
  const { apiKey, model, prompt, temperature, maxTokens, onStart, onChunk, onError, onComplete } = params;
  
  await sendStreamingRequest(
    {
      apiKey,
      model,
      prompt,
      temperature,
      maxTokens
    },
    {
      onStart,
      onChunk,
      onError,
      onComplete
    }
  );
}

/**
 * Send a message to Gemini without streaming
 * This is used by the WebSocket server to handle client requests
 */
export async function sendGeminiMessage(params: {
  apiKey: string;
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<LLMResponse> {
  const { apiKey, model, prompt, temperature, maxTokens } = params;
  
  return await sendRequest({
    apiKey,
    model,
    prompt,
    temperature,
    maxTokens
  });
}

export default {
  sendRequest,
  sendStreamingRequest,
  listModels,
  streamGeminiMessage,
  sendGeminiMessage
};
