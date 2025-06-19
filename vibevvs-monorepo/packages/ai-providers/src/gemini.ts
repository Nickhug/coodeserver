import {
  GoogleGenerativeAI,
  Content,
  Part,
  GenerateContentRequest,
  GenerationConfig,
} from '@google/generative-ai';
import logger from '@repo/logger';
import { LLMResponse } from './index';

// Re-export SDK types for internal consistency if needed, or use them directly
export type { Content as GeminiMessage, Part as GeminiPart };

// Model configuration remains the same
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

interface ThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
}

// Params for our service, which will be mapped to the SDK's params
export interface SendGeminiRequestParams {
  apiKey: string;
  model: string;
  messages: Content[];
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
  files?: { mimeType: string; data: string }[]; // Note: SDK handles files differently, this is a placeholder
  tools?: { name: string; description: string; parameters: Record<string, any>; required?: string[] }[] | null;
  chatMode?: 'normal' | 'gather' | 'agent';
  thinkingConfig?: ThinkingConfig;
}

/**
 * Get model config for Gemini models. (This can be simplified or enhanced using SDK's getModel)
 */
export function getModelConfig(model: string): GeminiModelConfig {
  const modelConfigMap: Record<GeminiModelName, GeminiModelConfig> = {
    'gemini-2.5-flash-preview-04-17': { contextWindow: 1048576, maxOutputTokens: 65536, tokenMultiplier: 1.0 },
    'gemini-2.5-pro-preview-05-06': { contextWindow: 2097152, maxOutputTokens: 65536, tokenMultiplier: 1.0 },
    'gemini-2.0-flash': { contextWindow: 128000, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-1.5-flash': { contextWindow: 128000, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-1.5-pro': { contextWindow: 1000000, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-1.5-flash-8b': { contextWindow: 128000, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-pro': { contextWindow: 30720, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-pro-vision': { contextWindow: 16385, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
  };
  return modelConfigMap[model as GeminiModelName] || { contextWindow: 30720, maxOutputTokens: 50000, tokenMultiplier: 1.0 };
}

/**
 * Estimate token count for a string.
 * This can be replaced by the SDK's `countTokens` method for accuracy.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// Helper to construct the request for the SDK
function buildGenerateContentRequest(params: SendGeminiRequestParams): GenerateContentRequest {
  const { messages, systemMessage, temperature, maxTokens, tools, chatMode, thinkingConfig } = params;

  const generationConfig: GenerationConfig = {
    temperature: temperature ?? 0.7,
    ...(maxTokens && { maxOutputTokens: maxTokens }),
    ...(thinkingConfig && { candidateCount: 1 }), // Placeholder for thinking config logic
  };

  const sdkTools: any[] | undefined = tools
    ? [
        {
          functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ]
    : undefined;

  const contents: Content[] = messages.map(msg => ({
    ...msg,
  }));
  
  if (systemMessage) {
    contents.unshift({ role: 'user', parts: [{ text: systemMessage }] });
    if(contents.length > 1) {
        contents[1].role = 'model'
    }
  }


  const request: GenerateContentRequest = {
    contents,
    generationConfig,
    ...(sdkTools && { tools: sdkTools }),
  };

  if (chatMode === 'agent' && sdkTools) {
    (request as any).toolConfig = {
      functionCallingConfig: {
        mode: 'AUTO', // Using string literal as FunctionCallingMode is not available
      },
    };
  }

  return request;
}

/**
 * Send a non-streaming request to the Gemini API using the SDK.
 */
export async function sendGeminiMessage(params: SendGeminiRequestParams): Promise<LLMResponse> {
  try {
    const { apiKey, model } = params;
    logger.info(`Starting Gemini SDK request with model: ${model}`);

    const genAI = new GoogleGenerativeAI(apiKey);
    const geminiModel = genAI.getGenerativeModel({ model });

    const request = buildGenerateContentRequest(params);
    const result = await geminiModel.generateContent(request);
    const response = result.response;

    logger.info(`GEMINI SDK RAW RESPONSE: ${JSON.stringify(response, null, 2)}`);

    const text = response.text();
    
    // The `functionCalls` is a property on the response object
    const functionCalls = (response as any).functionCalls;
    const usageMetadata = (response as any).usageMetadata;
    const totalTokens = usageMetadata?.totalTokenCount ?? 0;

    return {
      text,
      functionCalls: functionCalls,
      usage: {
        promptTokens: usageMetadata?.promptTokenCount ?? 0,
        completionTokens: usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: totalTokens,
      },
      success: true,
      tokensUsed: totalTokens,
      toolCall: functionCalls?.[0] ? { id: `fc-${Date.now()}`, name: functionCalls[0].name, parameters: functionCalls[0].args } : undefined,
      waitingForToolCall: !!functionCalls,
    };
  } catch (error) {
    logger.error('Error in Gemini SDK request:', error);
    return {
      text: '',
      functionCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      tokensUsed: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a streaming request to the Gemini API using the SDK.
 */
export async function streamGeminiMessage(params: {
  apiKey: string;
  model: string;
  messages: Content[];
  temperature?: number;
  maxTokens?: number;
  systemMessage?: string;
  tools?: { name: string; description: string; parameters: Record<string, any>; required?: string[] }[] | null;
  chatMode?: 'normal' | 'gather' | 'agent';
  thinkingConfig?: ThinkingConfig;
  onStart?: () => void;
  onChunk: (text: string, functionCalls: any[] | undefined) => void;
  onReasoningChunk?: (chunk: string) => void;
  onError: (error: Error) => void;
  onComplete: (response: LLMResponse) => void;
}): Promise<void> {
  const { onStart, onChunk, onError, onComplete } = params;
  let accumulatedText = '';
  let accumulatedFunctionCalls: any[] = [];
  let finalResponse: LLMResponse | null = null;

  try {
    logger.info(`Starting streaming Gemini SDK request with model: ${params.model}`);
    onStart?.();

    const genAI = new GoogleGenerativeAI(params.apiKey);
    const geminiModel = genAI.getGenerativeModel({ model: params.model });

    const request = buildGenerateContentRequest(params);
    const streamResult = await geminiModel.generateContentStream(request as any);

    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      const chunkFunctionCalls = (chunk as any).functionCalls?.();

      if (text) {
        accumulatedText += text;
      }
      if (chunkFunctionCalls) {
        accumulatedFunctionCalls.push(...chunkFunctionCalls);
      }

      onChunk(text, chunkFunctionCalls);
      logger.debug(`GEMINI SDK STREAM CHUNK: ${JSON.stringify(chunk)}`);
    }

    // After the stream is finished, the aggregated response is available
    const response = await streamResult.response;
    logger.info(`GEMINI SDK STREAM FINAL RESPONSE: ${JSON.stringify(response, null, 2)}`);
    const usageMetadata = (response as any).usageMetadata;
    const totalTokens = usageMetadata?.totalTokenCount ?? 0;

    finalResponse = {
      text: accumulatedText.trim(),
      functionCalls: accumulatedFunctionCalls.length > 0 ? accumulatedFunctionCalls : undefined,
      usage: {
        promptTokens: usageMetadata?.promptTokenCount ?? 0,
        completionTokens: usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: totalTokens,
      },
      success: true,
      tokensUsed: totalTokens,
      toolCall: accumulatedFunctionCalls?.[0] ? { id: `fc-${Date.now()}`, name: accumulatedFunctionCalls[0].name, parameters: accumulatedFunctionCalls[0].args } : undefined,
      waitingForToolCall: accumulatedFunctionCalls.length > 0,
    };
    onComplete(finalResponse);
  } catch (error: any) {
    logger.error('Error in Gemini SDK stream request:', error);
    onError(error);
    finalResponse = {
      text: accumulatedText.trim(),
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      tokensUsed: 0,
        success: false,
      error: error.message,
    };
    if (finalResponse) {
        onComplete(finalResponse);
    }
  }
}

/**
 * Lists available Gemini models from the SDK.
 */
export async function listModels(apiKey: string): Promise<Array<{ 
  id: string; 
  name: string; 
  provider: string;
  available: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  features: string[];
}>> {
  try {
    // This part of the SDK doesn't exist, so we mock it.
    // In a real scenario, you would adapt this if the SDK adds model listing.
    return getFallbackGeminiModels();
  } catch (error) {
    logger.error('Error listing Gemini models, returning fallback:', error);
    return getFallbackGeminiModels();
  }
}

function getFallbackGeminiModels(): Array<{ 
  id: string; 
  name: string; 
  provider: string;
  available: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  features: string[];
}> {
  const modelConfigMap: Record<GeminiModelName, GeminiModelConfig> = {
    'gemini-2.5-flash-preview-04-17': { contextWindow: 1048576, maxOutputTokens: 65536, tokenMultiplier: 1.0 },
    'gemini-2.5-pro-preview-05-06': { contextWindow: 2097152, maxOutputTokens: 65536, tokenMultiplier: 1.0 },
    'gemini-2.0-flash': { contextWindow: 128000, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-1.5-flash': { contextWindow: 128000, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-1.5-pro': { contextWindow: 1000000, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-1.5-flash-8b': { contextWindow: 128000, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-pro': { contextWindow: 30720, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
    'gemini-pro-vision': { contextWindow: 16385, maxOutputTokens: 50000, tokenMultiplier: 1.0 },
  };
  
  return Object.keys(modelConfigMap).map(id => {
    const config = modelConfigMap[id as GeminiModelName];
    return {
      id,
      name: id,
      provider: 'Google',
      available: true,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
      features: ['chat', 'tools'],
    }
  });
}

/**
 * Generates embeddings using the Gemini API.
 */
export async function generateEmbedding(params: {
  apiKey: string;
  content: string;
  model?: string;
}): Promise<{
  embedding: number[];
  tokensUsed: number;
  model: string;
  error?: string;
}> {
  try {
    const { apiKey, content, model = 'text-embedding-004' } = params;
    const genAI = new GoogleGenerativeAI(apiKey);
    const embeddingModel = genAI.getGenerativeModel({ model });

    const result = await embeddingModel.embedContent(content);
    const embedding = result.embedding.values;

    // Token count is not directly available in embedContent response, must be calculated separately if needed.
    // This is a simplification.
    const tokensUsed = estimateTokenCount(content);

    return { embedding, tokensUsed, model };
  } catch (error) {
    logger.error('Error in Gemini embedding request:', error);
    return {
      embedding: [],
      tokensUsed: 0,
      model: params.model || 'text-embedding-004',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generates embeddings for a batch of content.
 */
export async function generateBatchEmbeddings(params: {
  apiKey: string;
  contents: Array<{ id: string; content: string }>;
  model?: string;
  batchSize?: number;
}): Promise<{
  embeddings: Array<{
    id: string;
    embedding: number[];
    tokensUsed: number;
    error?: string;
  }>;
  totalTokensUsed: number;
  model: string;
}> {
  const { apiKey, contents, model = 'text-embedding-004', batchSize = 100 } = params;
  const genAI = new GoogleGenerativeAI(apiKey);
  const embeddingModel = genAI.getGenerativeModel({ model });
  
  const allEmbeddings: Array<{
    id: string;
    embedding: number[];
    tokensUsed: number;
    error?: string;
  }> = [];
  let totalTokensUsed = 0;
  
  for (let i = 0; i < contents.length; i += batchSize) {
    const batch = contents.slice(i, i + batchSize);
    const batchContents = batch.map(item => item.content);

    try {
      const result = await embeddingModel.batchEmbedContents({
        requests: batchContents.map(content => ({ content: { role: 'user', parts: [{ text: content }] } })),
      });
      const embeddings = result.embeddings;

      batch.forEach((item, index) => {
        const tokens = estimateTokenCount(item.content);
        totalTokensUsed += tokens;
        allEmbeddings.push({
          id: item.id,
          embedding: embeddings[index].values,
          tokensUsed: tokens,
        });
      });
      } catch (error) {
      logger.error(`Error in Gemini batch embedding request for batch starting at index ${i}:`, error);
      batch.forEach(item => {
        allEmbeddings.push({
          id: item.id,
          embedding: [],
          tokensUsed: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        });
      }
    }
    
  return { embeddings: allEmbeddings, totalTokensUsed, model };
}


/**
 * Generates an answer based on a query and passages.
 * This is a mocked implementation as the Gemini SDK does not have a direct `generateAnswer` equivalent.
 * This would typically be implemented using a standard `generateContent` call with a well-formed prompt.
 */
export async function generateAnswer(params: {
  apiKey: string;
  model: string;
  query: string;
  passages: Array<{ id: string; content: string }>;
  answerStyle?: 'ABSTRACTIVE' | 'EXTRACTIVE' | 'VERBOSE';
  temperature?: number;
}): Promise<{
  answer: string;
  answerableProbability: number;
  sources: Array<{ id:string; relevanceScore?: number }>;
  tokensUsed: number;
  error?: string;
}> {
  const { apiKey, model, query, passages, temperature } = params;
  
  const prompt = `Based on the following passages, answer the query: "${query}".\n\nPassages:\n${passages.map(p => `- ${p.content}`).join('\n')}`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const llm = genAI.getGenerativeModel({ model });

    const result = await llm.generateContent({
        contents: [{role: 'user', parts: [{text: prompt}]}],
        generationConfig: {
            temperature: temperature ?? 0.7,
        }
    });

    const response = result.response;
    const text = response.text();
    const usageMetadata = (response as any).usageMetadata;
    const tokensUsed = usageMetadata?.totalTokenCount ?? 0;

    // Mocking other fields as the SDK doesn't provide them directly
    return {
      answer: text,
      answerableProbability: 0.9, 
      sources: passages.map(p => ({ id: p.id, relevanceScore: 0.8 })),
      tokensUsed,
    };
  } catch (error) {
    logger.error('Error in generateAnswer:', error);
    return {
      answer: '',
      answerableProbability: 0,
      sources: [],
      tokensUsed: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
