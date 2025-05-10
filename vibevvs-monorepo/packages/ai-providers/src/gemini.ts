import { GoogleGenerativeAI, GenerativeModel, GenerateContentStreamResult } from '@google/generative-ai';
import logger from '@repo/logger';
import { LLMResponse } from './index';

// Types for Gemini
export type GeminiModelName =
  | 'gemini-2.5-flash-preview-04-17'
  | 'gemini-2.5-pro-preview-05-06'
  | 'gemini-2.0-flash'
  | 'gemini-1.5-flash'
  | 'gemini-1.5-pro'
  | 'gemini-1.5-flash-8b'
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

/**
 * Get model config for Gemini models.
 */
export function getModelConfig(model: string): GeminiModelConfig {
  const modelConfigMap: Record<GeminiModelName, GeminiModelConfig> = {
    'gemini-2.5-flash-preview-04-17': {
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      tokenMultiplier: 1.0
    },
    'gemini-2.5-pro-preview-05-06': {
      contextWindow: 2097152,
      maxOutputTokens: 65536,
      tokenMultiplier: 1.0
    },
    'gemini-2.0-flash': {
      contextWindow: 128000,
      maxOutputTokens: 8192,
      tokenMultiplier: 1.0
    },
    'gemini-1.5-flash': {
      contextWindow: 128000, 
      maxOutputTokens: 8192,
      tokenMultiplier: 1.0
    },
    'gemini-1.5-pro': {
      contextWindow: 1000000,
      maxOutputTokens: 8192,
      tokenMultiplier: 1.0
    },
    'gemini-1.5-flash-8b': {
      contextWindow: 128000,
      maxOutputTokens: 8192,
      tokenMultiplier: 1.0
    },
    'gemini-pro': {
      contextWindow: 30720,
      maxOutputTokens: 2048,
      tokenMultiplier: 1.0
    },
    'gemini-pro-vision': {
      contextWindow: 16385,
      maxOutputTokens: 2048,
      tokenMultiplier: 1.0
    }
  };

  return modelConfigMap[model as GeminiModelName] || {
    contextWindow: 30720,
    maxOutputTokens: 2048,
    tokenMultiplier: 1.0
  };
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
 * Create a Gemini client for the API
 */
export function createGeminiClient(apiKey: string): GoogleGenerativeAI {
  return new GoogleGenerativeAI(apiKey);
}

/**
 * Get the appropriate Gemini model based on name
 * This handles the correct API version selection (v1 vs v1beta)
 */
export function getGeminiModel(client: GoogleGenerativeAI, modelName: string): any {
  // Use v1beta endpoint for preview models
  const apiVersion = 'v1beta'; // Always use v1beta as requested
  
  logger.info(`Using API version ${apiVersion} for Gemini model: ${modelName}`);
  
  // For the Node.js client, we need to set the apiVersion before getting the model
  const generationConfig: any = {
    apiVersion,
  };
  
  return client.getGenerativeModel({ model: modelName, generationConfig });
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
    
    // Format prompt for direct API call
    const formattedPrompt = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature,
        ...(maxTokens && { maxOutputTokens: maxTokens })
      }
    };
    
    // Direct API call to v1beta endpoint
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    
    // Using node-fetch or native fetch depending on environment
    const fetch = globalThis.fetch;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(formattedPrompt)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const data = await response.json();
    
    // Extract the response text
    let text = '';
    let toolCall: { name: string; parameters: Record<string, unknown>; id: string } | undefined;
    
    if (data.candidates && data.candidates.length > 0) {
      const candidate = data.candidates[0];
      if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        for (const part of candidate.content.parts) {
          // Extract text content
          if (part.text) {
            text += part.text;
          }
          
          // Check if this part contains a function call
          if (part.functionCall) {
            toolCall = {
              name: part.functionCall.name,
              parameters: part.functionCall.args || {},
              id: candidate.contentId || 'unknown'
            };
            logger.info(`Detected tool call in response: ${toolCall.name}`);
          }
        }
      }
    }
    
    // Estimate token usage (Google doesn't provide token counts directly)
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
      toolCall,
      waitingForToolCall: toolCall !== undefined,
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
    
    // Call onStart handler
    if (handlers.onStart) {
      handlers.onStart();
    }
    
    // Format prompt for direct API call
    const formattedPrompt = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature,
        ...(maxTokens && { maxOutputTokens: maxTokens })
      }
    };
    
    // Direct API call to v1beta endpoint
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    
    // Using node-fetch or native fetch depending on environment
    const fetch = globalThis.fetch;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(formattedPrompt)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    if (!response.body) {
      throw new Error('Response body is null');
    }
    
    // Process the SSE stream
    const reader = response.body.getReader();
    let completeText = '';
    let toolCall: { name: string; parameters: Record<string, unknown>; id: string } | undefined;
    const decoder = new TextDecoder();
    
    let chunk;
    while (!(chunk = await reader.read()).done) {
      const rawText = decoder.decode(chunk.value, { stream: true });
      
      // Parse SSE format (data: {json})
      const lines = rawText.split('\n').filter(line => line.trim() !== '');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            // Skip "[DONE]" message at the end
            if (line === 'data: [DONE]') continue;
            
            const jsonText = line.slice(6); // Remove "data: " prefix
            const data = JSON.parse(jsonText);
            
            // Extract text content
            let chunkText = '';
            if (data.candidates && 
                data.candidates[0]?.content?.parts && 
                data.candidates[0].content.parts.length > 0) {
              
              // Check for function calls
              for (const part of data.candidates[0].content.parts) {
                if (part.text) {
                  chunkText += part.text;
                }
                
                // Check for function calls (tool calls)
                if (part.functionCall) {
                  toolCall = {
                    name: part.functionCall.name,
                    parameters: part.functionCall.args || {},
                    id: data.candidates[0].contentId || 'unknown'
                  };
                  logger.info(`Detected tool call in stream: ${toolCall.name}`);
                }
              }
              
              // Call onChunk handler
              if (chunkText) {
                handlers.onChunk(chunkText);
                completeText += chunkText;
              }
            }
          } catch (error) {
            logger.error('Error parsing SSE chunk:', error);
          }
        }
      }
    }
    
    // Estimate token usage
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(completeText.length / 4);
    const totalTokens = inputTokens + outputTokens;
    
    logger.info(`Gemini stream completed, estimated tokens: ${totalTokens}`);
    
    // Call onComplete handler
    handlers.onComplete({
      text: completeText,
      tokensUsed: totalTokens,
      creditsUsed: totalTokens / 1000, // Assuming 1000 tokens = 1 credit
      success: true,
      generatedText: completeText,
      toolCall,
      waitingForToolCall: toolCall !== undefined,
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
      { id: 'gemini-2.5-flash-preview-04-17', name: 'Gemini 2.5 Flash Preview' },
      { id: 'gemini-2.5-pro-preview-05-06', name: 'Gemini 2.5 Pro Preview' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
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
