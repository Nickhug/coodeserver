// Copyright (c) COODE AI EDITOR. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import { Mistral } from '@mistralai/mistralai';
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
    CompletionEvent, // Type for the wrapper of streamed chat events
    CompletionChunk, // Type for the data within CompletionEvent
    FIMCompletionResponse,
    UsageInfo,
    Messages as ChatMessage, // Changed from Message to Messages
    ToolCall as MistralToolCall, // Tool calls in response
    DeltaMessage, // Contains delta for content and tool_calls in a stream chunk choice
} from '@mistralai/mistralai/models/components';
import { config } from './config';

// Helper to ensure content is a string
function ensureStringContent(content: string | any[] | null | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(item => (typeof item === 'string' ? item : item?.text || ''))
      .join('');
  }
  return '';
}
import logger from '@repo/logger';
// Dynamically import node-fetch as it is an ES Module

// Constants
const EMBEDDING_MODEL = 'codestral-embed';
const OUTPUT_DIMENSION = 3072; // Maximum dimension supported by the model

/**
 * Generate an embedding for a single text input
 */
export async function generateEmbedding({
  apiKey,
  content,
}: {
  apiKey: string;
  content: string;
}): Promise<{
  embedding: number[];
  model: string;
  tokensUsed?: number;
  error?: string;
}> {
  try {
    const client = new Mistral({ apiKey });
    
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      outputDimension: OUTPUT_DIMENSION,
      inputs: [content],
    });
    
    if (!response.data || response.data.length === 0 || !response.data[0].embedding) {
      return {
        embedding: [],
        model: EMBEDDING_MODEL,
        error: 'No embedding returned from Mistral API',
      };
    }
    
    return {
      embedding: response.data[0].embedding,
      model: response.model,
      tokensUsed: response.usage?.totalTokens,
    };
  } catch (error) {
    logger.error(`Mistral embedding generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      embedding: [],
      model: EMBEDDING_MODEL,
      error: `Mistral API error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Generate embeddings for multiple text inputs in batch
 */
export async function generateBatchEmbeddings({
  apiKey,
  contents,
}: {
  apiKey: string;
  contents: Array<{ id: string; content: string }>;
  batchSize?: number; // Not used here as we handle batching differently
}): Promise<{
  embeddings: Array<{
    id: string;
    embedding: number[];
    tokensUsed?: number;
    error?: string;
  }>;
  totalTokensUsed: number;
}> {
  try {
    const client = new Mistral({ apiKey });
    
    // Extract content from the contents array
    const inputs = contents.map((item) => item.content);
    
    // Generate embeddings
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      outputDimension: OUTPUT_DIMENSION,
      inputs,
    });
    
    // Map response back to the original IDs
    const embeddings = contents.map((item, index) => {
      if (!response.data || !response.data[index] || !response.data[index].embedding) {
        return {
          id: item.id,
          embedding: [],
          error: `No embedding returned for item ${item.id}`,
        };
      }
      
      return {
        id: item.id,
        embedding: response.data[index].embedding,
        tokensUsed: response.usage ? Math.ceil(response.usage.totalTokens / inputs.length) : undefined,
      };
    });
    
    return {
      embeddings,
      totalTokensUsed: response.usage?.totalTokens || 0,
    };
  } catch (error) {
    logger.error(`Mistral batch embedding generation failed: ${error instanceof Error ? error.message : String(error)}`);
    
    // Return error for all items in the batch
    return {
      embeddings: contents.map((item) => ({
        id: item.id,
        embedding: [],
        error: `Mistral API error: ${error instanceof Error ? error.message : String(error)}`,
      })),
      totalTokensUsed: 0,
    };
  }
}

/**
 * Process a Fill-In-Middle (FIM) request using Codestral model
 */
/**
 * Process a Fill-In-Middle (FIM) request using Codestral model
 */
export async function processFIM({
  apiKey,
  prefix,
  suffix,
  model = 'codestral-latest',
  temperature = 0.2,
  maxTokens = 512,
  stream = true,
  stopSequences = [],
  onStream,
  onFinal,
  onError,
}: {
  apiKey: string;
  prefix: string;
  suffix: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  stopSequences?: string[];
  onStream?: (chunk: string) => void;
  onFinal?: (text: string, tokensUsed?: number) => void; // Added tokensUsed
  onError?: (error: Error) => void;
}): Promise<void> {
  try {
    logger.info(`Mistral Codestral FIM request: model=${model}, stream=${stream}, temp=${temperature}`);
    
    // Validate inputs
    if (!prefix) { // Prefix (prompt) is essential for FIM
      throw new Error('Prefix (prompt) must be provided for FIM');
    }

    // Log token length for diagnostics (approximate)
    logger.debug(`Mistral FIM approximate input sizes: prefix=${prefix.length / 4} chars, suffix=${suffix.length / 4} chars`);
    
    const client = new Mistral({ apiKey }); // Initialize client with options object

    if (stream && onStream && onFinal) {
      try {
        let accumulatedText = '';
        let finalUsage: UsageInfo | undefined;

        const streamResponse = await client.fim.stream({
          model,
          prompt: prefix,
          suffix: suffix || undefined,
          temperature,
          maxTokens,
          stop: stopSequences.length > 0 ? stopSequences : undefined,
        });

        for await (const event of streamResponse) {
          const chunk = (event as any).data; // FIM stream chunk
          if (chunk && chunk.choices && chunk.choices.length > 0) {
            const choice = chunk.choices[0];
            const content = ensureStringContent(choice.delta?.content);
            if (content) {
              accumulatedText += content;
              onStream(content);
            }
          }
          if (chunk && chunk.usage) {
            finalUsage = chunk.usage;
          }
        }
        onFinal(accumulatedText, finalUsage?.totalTokens);
      } catch (streamError) {
        logger.error(`Mistral FIM stream error: ${streamError instanceof Error ? streamError.message : String(streamError)}`);
        if (onError) {
          onError(streamError instanceof Error ? streamError : new Error(String(streamError)));
        }
      }
    } else if (onFinal) { // Non-streaming FIM using SDK
      logger.debug(`Mistral FIM (non-stream) using SDK: model=${model}, prefix_len=${prefix.length}, suffix_len=${suffix?.length || 0}`);
      
      const fimResponse: FIMCompletionResponse = await client.fim.complete({
        model,
        prompt: prefix,
        suffix: suffix || undefined,
        temperature,
        maxTokens,
        stop: stopSequences.length > 0 ? stopSequences : undefined,
      });

      const tokensUsed = fimResponse.usage?.totalTokens;
      const completionText = ensureStringContent(fimResponse.choices[0].message.content);
      onFinal(completionText, tokensUsed);
    } else {
      // Fallback or error if no onFinal provided for non-streaming
      logger.warn('Mistral FIM: onFinal callback not provided for non-streaming request.');
    }
  } catch (error) {
    logger.error(`Mistral FIM processing error: ${error instanceof Error ? error.message : String(error)}`);
    if (onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Process a Chat request using Mistral models
 */
export async function processChat({
  apiKey,
  model = 'codestral-latest', // Default to codestral, or use specific chat models like 'mistral-large-latest'
  messages,
  temperature = 0.7,
  maxTokens,
  stream = false,
  stopSequences = [],
  // tools, // TODO: Add tool support if needed later
  // tool_choice, // TODO: Add tool support if needed later
  onStream,
  onFinal,
  onError,
}: {
  apiKey: string;
  model?: string;
  messages: ChatMessage[]; // Correctly using the aliased ChatMessage
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  stopSequences?: string[];
  // tools?: any[];
  // tool_choice?: string;
  onStream?: (chunk: string) => void;
  onFinal?: (fullText: string, tokensUsed?: number, toolCalls?: MistralToolCall[], finishReason?: string | null) => void; // finishReason can be null
  onError?: (error: Error) => void;
}): Promise<void> {
  try {
    const client = new Mistral({ apiKey });
    logger.info(`Mistral Chat request: model=${model}, stream=${stream}, temp=${temperature}, messages_count=${messages.length}`);

    if (stream && onStream && onFinal) {
      let fullResponseText = '';
      let accumulatedToolCalls: any[] = [];
      let finalUsage: UsageInfo | undefined;
      let finalFinishReason: string | null = null;

      const streamResponse = await client.chat.stream({
        model,
        messages,
        temperature,
        maxTokens,
        stop: stopSequences.length > 0 ? stopSequences : undefined,
      });

      for await (const event of streamResponse) { // event is CompletionEvent
        const chunk = event.data as CompletionChunk; // Assuming 'data' holds the CompletionChunk
        if (chunk && chunk.choices && chunk.choices.length > 0) {
          const choice = chunk.choices[0];
          const delta = choice.delta as DeltaMessage; // Cast delta to DeltaMessage
            const currentContent = ensureStringContent(delta?.content);
            if (currentContent) {
            fullResponseText += currentContent;
            onStream(currentContent);
          }
          if (delta && delta.toolCalls) { // Corrected to toolCalls
            delta.toolCalls.forEach((tc: MistralToolCall, index: number) => { // Corrected to toolCalls and typed tc, index
              if (tc.function?.name || tc.function?.arguments) { // Check if there's something to add/update
                let existingToolCall = accumulatedToolCalls[index]; // Use the index from forEach
                if (!existingToolCall) {
                  accumulatedToolCalls[index] = {
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.function.name || '', arguments: tc.function.arguments || "" }
                  };
                } else {
                  if (tc.id && !existingToolCall.id) existingToolCall.id = tc.id;
                  if (tc.function.name && !existingToolCall.function.name) existingToolCall.function.name = tc.function.name;
                  if (tc.function.arguments) existingToolCall.function.arguments += tc.function.arguments;
                }
              }
            });
          }
          if (choice.finishReason) { // Corrected casing
            finalFinishReason = choice.finishReason;
          }
        }
        if (chunk && chunk.usage) { 
            finalUsage = chunk.usage as UsageInfo;
        }
      }
      accumulatedToolCalls = accumulatedToolCalls.filter(tc => tc && tc.function && tc.function.name);

      onFinal(fullResponseText, finalUsage?.totalTokens, accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined, finalFinishReason || undefined);

    } else if (onFinal) { // Non-streaming
      const response: ChatCompletionResponse = await client.chat.complete({
        model,
        messages,
        temperature,
        maxTokens,
        stop: stopSequences.length > 0 ? stopSequences : undefined,
        // tools,
        // tool_choice,
      });

      const choice = response.choices && response.choices.length > 0 ? response.choices[0] : null;
      const completionText = ensureStringContent(choice?.message?.content);
      const tokensUsed = (response.usage as UsageInfo)?.totalTokens; // Verified casing
      const toolCalls = choice?.message?.toolCalls as MistralToolCall[] | undefined; // Corrected to toolCalls
      const finishReason = choice?.finishReason; // Corrected to finishReason

      onFinal(completionText, tokensUsed, toolCalls, finishReason || undefined);
    } else {
      logger.warn('Mistral Chat: onFinal callback not provided for non-streaming request.');
    }
  } catch (error) {
    logger.error(`Mistral Chat error: ${error instanceof Error ? error.message : String(error)}`);
    if (onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * List available Mistral models (for compatibility with other provider interfaces)
 */
export async function listModels(apiKey: string): Promise<any[]> {
  return [
    { id: 'codestral-embed', name: 'Codestral Embed' },
    { id: 'codestral-latest', name: 'Codestral Latest', capabilities: ['fim', 'completion'] },
  ];
}
