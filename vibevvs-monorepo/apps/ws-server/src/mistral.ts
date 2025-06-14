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

// Helper to check if model is a reasoning model
function isReasoningModel(model: string): boolean {
  const reasoningModels = [
    'magistral-small-2506',
    'magistral-medium-2506',
    'magistral-large-2506',
    // Add other reasoning models as they become available
  ];
  return reasoningModels.some(reasoningModel => model.includes(reasoningModel));
}

// Helper to convert tools to Mistral's expected format
function convertToolsToMistralFormat(tools: any[]): any[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }

  return tools.map(tool => {
    // Convert Void tool format to Mistral tool format
    const mistralTool = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: {} as any,
          required: [] as string[]
        }
      }
    };

    // Convert parameters from Void format to Mistral JSON Schema format
    if (tool.parameters && typeof tool.parameters === 'object') {
      Object.entries(tool.parameters).forEach(([paramName, paramInfo]: [string, any]) => {
        mistralTool.function.parameters.properties[paramName] = {
          type: 'string', // Default to string for Mistral
          description: paramInfo.description || ''
        };
        
        // Add to required if it seems required (you can adjust this logic)
        if (paramInfo.required !== false) {
          mistralTool.function.parameters.required.push(paramName);
        }
      });
    }

    return mistralTool;
  });
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
  model = 'mistral-large-latest', // ✅ FIXED: Use proper chat model instead of codestral-latest
  messages,
  systemMessage, // ✅ ADDED: System message support
  temperature = 0.7,
  maxTokens,
  stream = false,
  stopSequences = [],
  tools, // ✅ ADDED: Tool support
  toolChoice, // ✅ ADDED: Tool choice support
  parallelToolCalls, // ✅ ADDED
  chatMode, // ✅ ADDED: Missing chatMode parameter
  onStream,
  onReasoningChunk, // ✅ ADDED: For reasoning tokens
  onFinal,
  onError,
}: {
  apiKey: string;
  model?: string;
  messages: ChatMessage[]; // Correctly using the aliased ChatMessage
  systemMessage?: string; // ✅ ADDED: System message support
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  stopSequences?: string[];
  tools?: any[]; // ✅ ADDED: Tool definitions
  toolChoice?: string; // ✅ ADDED: Tool choice option
  parallelToolCalls?: boolean; // ✅ ADDED
  chatMode?: 'normal' | 'gather' | 'agent'; // ✅ ADDED: Missing chatMode parameter
  onStream?: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void; // ✅ ADDED: For reasoning tokens
  onFinal?: (fullText: string, tokensUsed?: number, toolCalls?: MistralToolCall[], finishReason?: string | null, reasoning?: string) => void; // ✅ ADDED: reasoning field
  onError?: (error: Error) => void;
}): Promise<void> {
  try {
    const client = new Mistral({ apiKey });
    
    // ✅ ADDED: Prepare messages array for Mistral API
    const mistralMessages: ChatMessage[] = [];
    
    // ✅ ADDED: Add enhanced system message if present (like Gemini does)
    if (systemMessage) {
      let enhancedSystemMessage = systemMessage;
      
      // If we have tools and a chatMode, explicitly tell the model what mode it's in
      if (tools && tools.length > 0 && chatMode) {
        logger.info(`Adding chatMode (${chatMode}) context to Mistral system message`);
        // Include specific tool names in the system message
        const toolNames = tools.map(t => t.name).join(', ');
        
        // For Mistral, we need to explicitly tell it to use native function calling
        // instead of XML format when tools are available
        enhancedSystemMessage = `${systemMessage}

IMPORTANT: You are currently in ${chatMode} mode and have access to the following tools: ${toolNames}. 

TOOL CALLING INSTRUCTIONS:
- You have access to function calling capabilities
- When you need to use a tool, use the native function calling format
- DO NOT use XML format like [tool_name] or <tool_name>
- The system will automatically execute your tool calls and return results
- After calling a tool, wait for the result before continuing
- In agent mode, you SHOULD use tools to complete tasks including file creation and editing

${isReasoningModel(model) ? `
REASONING INSTRUCTIONS:
- You are a reasoning model - use <think> tags to show your reasoning process
- Put your step-by-step thinking inside <think></think> tags
- After your reasoning, provide your final response outside the think tags
- Use reasoning to plan your approach before taking actions
` : ''}`;
      }
      
      mistralMessages.push({ role: 'system', content: enhancedSystemMessage });
      logger.info(`Added enhanced system message to Mistral request, total length: ${enhancedSystemMessage.length}`);
    }
    
    // Add the conversation messages
    mistralMessages.push(...messages);

    // ✅ ADDED: Log tools being sent to Mistral API
    if (tools && tools.length > 0) {
      const convertedTools = convertToolsToMistralFormat(tools);
      logger.info(`Mistral Chat request: Converting ${tools.length} tools to Mistral format`);
      logger.info(`Original tools sample: ${JSON.stringify(tools[0], null, 2)}`);
      logger.info(`Converted tools sample: ${JSON.stringify(convertedTools[0], null, 2)}`);
    } else {
      logger.info(`Mistral Chat request: No tools provided`);
    }

    if (stream && onStream && onFinal) {
      let fullResponseText = '';
      let accumulatedReasoning = ''; // ✅ ADDED: Track reasoning content
      let accumulatedToolCalls: any[] = [];
      let finalUsage: UsageInfo | undefined;
      let finalFinishReason: string | null = null;

      // ✅ ADDED: State tracking for parsing <think> tags
      let insideThinkingTags = false;
      let pendingContent = ''; // Buffer for processing content that might contain think tags

      const streamResponse = await client.chat.stream({
        model,
        messages: mistralMessages,
        temperature,
        maxTokens,
        stop: stopSequences.length > 0 ? stopSequences : undefined,
        tools: tools && tools.length > 0 ? convertToolsToMistralFormat(tools) : undefined, // ✅ ADDED: Tool support
        toolChoice: toolChoice as any || undefined, // ✅ ADDED: Tool choice support (cast to any for flexibility)
        parallelToolCalls, // ✅ ADDED
      });

      for await (const event of streamResponse) { // event is CompletionEvent
        const chunk = event.data as CompletionChunk; // Assuming 'data' holds the CompletionChunk
        if (chunk && chunk.choices && chunk.choices.length > 0) {
          const choice = chunk.choices[0];
          const delta = choice.delta as DeltaMessage; // Cast delta to DeltaMessage
          const currentContent = ensureStringContent(delta?.content);
          if (currentContent) {
            // ✅ ADDED: Process content through thinking tag parser
            pendingContent += currentContent;
            
            // Process complete tags in the pending content
            while (true) {
              if (!insideThinkingTags) {
                // Look for opening <think> tag
                const thinkStartIndex = pendingContent.indexOf('<think>');
                if (thinkStartIndex !== -1) {
                  // Send any content before the think tag as regular content
                  const beforeThink = pendingContent.substring(0, thinkStartIndex);
                  if (beforeThink) {
                    fullResponseText += beforeThink;
                    onStream(beforeThink);
                  }
                  
                  insideThinkingTags = true;
                  pendingContent = pendingContent.substring(thinkStartIndex + 7); // Remove '<think>'
                } else {
                  // No opening tag found, send all content as regular
                  fullResponseText += pendingContent;
                  onStream(pendingContent);
                  pendingContent = '';
                  break;
                }
              } else {
                // Look for closing </think> tag
                const thinkEndIndex = pendingContent.indexOf('</think>');
                if (thinkEndIndex !== -1) {
                  // Send thinking content as reasoning chunk
                  const thinkingContent = pendingContent.substring(0, thinkEndIndex);
                  if (thinkingContent && onReasoningChunk) {
                    accumulatedReasoning += thinkingContent;
                    onReasoningChunk(thinkingContent);
                  }
                  
                  insideThinkingTags = false;
                  pendingContent = pendingContent.substring(thinkEndIndex + 8); // Remove '</think>'
                } else {
                  // No closing tag yet, send all as reasoning
                  if (pendingContent && onReasoningChunk) {
                    accumulatedReasoning += pendingContent;
                    onReasoningChunk(pendingContent);
                  }
                  pendingContent = '';
                  break;
                }
              }
            }
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
      
      // ✅ ADDED: Handle any remaining pending content at the end of stream
      if (pendingContent) {
        if (insideThinkingTags && onReasoningChunk) {
          // Still inside thinking tags, treat as reasoning
          accumulatedReasoning += pendingContent;
          onReasoningChunk(pendingContent);
        } else {
          // Regular content
          fullResponseText += pendingContent;
          onStream(pendingContent);
        }
      }
      
      accumulatedToolCalls = accumulatedToolCalls.filter(tc => tc && tc.function && tc.function.name);

      onFinal(fullResponseText, finalUsage?.totalTokens, accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined, finalFinishReason || undefined, accumulatedReasoning || undefined); // ✅ ADDED: reasoning parameter

    } else if (onFinal) { // Non-streaming
      const response: ChatCompletionResponse = await client.chat.complete({
        model,
        messages: mistralMessages,
        temperature,
        maxTokens,
        stop: stopSequences.length > 0 ? stopSequences : undefined,
        tools: tools && tools.length > 0 ? convertToolsToMistralFormat(tools) : undefined, // ✅ ADDED: Tool support
        toolChoice: toolChoice as any || undefined, // ✅ ADDED: Tool choice support (cast to any for flexibility)
        parallelToolCalls, // ✅ ADDED
      });

      const choice = response.choices && response.choices.length > 0 ? response.choices[0] : null;
      const rawCompletionText = ensureStringContent(choice?.message?.content);
      const tokensUsed = (response.usage as UsageInfo)?.totalTokens; // Verified casing
      const toolCalls = choice?.message?.toolCalls as MistralToolCall[] | undefined; // Corrected to toolCalls
      const finishReason = choice?.finishReason; // Corrected to finishReason

      // ✅ ADDED: Extract reasoning from non-streaming response
      let completionText = rawCompletionText;
      let extractedReasoning = '';
      
      // Parse out <think> tags if present
      const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
      let match;
      let lastIndex = 0;
      let cleanedText = '';
      
      while ((match = thinkRegex.exec(rawCompletionText)) !== null) {
        // Add text before the think tag
        cleanedText += rawCompletionText.substring(lastIndex, match.index);
        // Accumulate reasoning content
        extractedReasoning += match[1];
        lastIndex = match.index + match[0].length;
      }
      
      // Add remaining text after last think tag
      cleanedText += rawCompletionText.substring(lastIndex);
      
      // Use cleaned text if we found reasoning, otherwise use original
      if (extractedReasoning) {
        completionText = cleanedText.trim();
      }

      onFinal(completionText, tokensUsed, toolCalls, finishReason || undefined, extractedReasoning || undefined); // ✅ ADDED: reasoning parameter
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
    // Embedding models
    { id: 'codestral-embed', name: 'Codestral Embed', capabilities: ['embedding'] },
    
    // Code models (for FIM)
    { id: 'codestral-latest', name: 'Codestral Latest', capabilities: ['fim', 'completion'] },
    
    // Chat models
    { id: 'mistral-large-latest', name: 'Mistral Large Latest', capabilities: ['chat', 'reasoning'] },
    { id: 'mistral-small-latest', name: 'Mistral Small Latest', capabilities: ['chat'] },
    { id: 'mistral-medium-2506', name: 'Mistral Medium 2506', capabilities: ['chat', 'reasoning'] }, // ✅ ADDED: New model
    { id: 'open-mistral-7b', name: 'Open Mistral 7B', capabilities: ['chat'] },
    { id: 'open-mixtral-8x7b', name: 'Open Mixtral 8x7B', capabilities: ['chat'] },
    { id: 'open-mixtral-8x22b', name: 'Open Mixtral 8x22B', capabilities: ['chat'] },
  ];
}
