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

interface ThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
}

/**
 * Helper function to convert camelCase keys to snake_case
 * This normalizes Gemini's camelCase parameter names to the snake_case format expected by the client
 */
function convertCamelCaseToSnakeCase(obj: any): any {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(convertCamelCaseToSnakeCase);
  }
  
  const converted: any = {};
  for (const [key, value] of Object.entries(obj)) {
    // Convert camelCase to snake_case
    const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    converted[snakeKey] = convertCamelCaseToSnakeCase(value);
    
    // Also keep the original key for backward compatibility
    if (snakeKey !== key) {
      converted[key] = convertCamelCaseToSnakeCase(value);
    }
  }
  
  return converted;
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
  chatMode?: 'normal' | 'gather' | 'agent';
  thinkingConfig?: ThinkingConfig;
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
      maxOutputTokens: 50000,
      tokenMultiplier: 1.0
    },
    'gemini-1.5-flash': {
      contextWindow: 128000, 
      maxOutputTokens: 50000,
      tokenMultiplier: 1.0
    },
    'gemini-1.5-pro': {
      contextWindow: 1000000,
      maxOutputTokens: 50000,
      tokenMultiplier: 1.0
    },
    'gemini-1.5-flash-8b': {
      contextWindow: 128000,
      maxOutputTokens: 50000,
      tokenMultiplier: 1.0
    },
    'gemini-pro': {
      contextWindow: 30720,
      maxOutputTokens: 50000,
      tokenMultiplier: 1.0
    },
    'gemini-pro-vision': {
      contextWindow: 16385,
      maxOutputTokens: 50000,
      tokenMultiplier: 1.0
    }
  };

  return modelConfigMap[model as GeminiModelName] || {
    contextWindow: 30720,
    maxOutputTokens: 50000,
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
  messages: GeminiMessage[];
  temperature?: number;
  maxTokens?: number;
  systemMessage?: string;
  tools?: any[];
  chatMode?: 'normal' | 'gather' | 'agent';
  thinkingConfig?: ThinkingConfig;
}

interface GeminiStreamHandler {
  onStart?: () => void;
  onChunk: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  onError: (error: Error) => void;
  onComplete: (response: LLMResponse) => void;
}

/**
 * Send a request to the Gemini API
 */
export async function sendRequest(params: GeminiRequestParams): Promise<LLMResponse> {
  try {
    const { apiKey, model, messages, temperature = 0.7, maxTokens, systemMessage, tools, chatMode } = params;
    
    logger.info(`Starting Gemini request with model: ${model}`);
    
    // Format request body
    let requestBody: any = {
      contents: messages,
      generationConfig: {
        temperature,
        ...(maxTokens && { maxOutputTokens: maxTokens })
      }
    };
    
    // Add system message if present
    if (systemMessage) {
      requestBody.systemInstruction = {
        role: 'model',
        parts: [{ text: systemMessage }]
      };
      logger.info(`Added system message to request, length: ${systemMessage.length}`);
    }
    
    // Add tools if present
    if (tools && Array.isArray(tools) && tools.length > 0) {
      requestBody.tools = tools.map(tool => ({
        functionDeclarations: [{
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'OBJECT',
            properties: tool.parameters || {}
          }
        }]
      }));
      
      logger.info(`Added ${tools.length} tools to request: ${tools.map(t => t.name).join(', ')}`);
      
      // If we have a chatMode, log it
      if (chatMode) {
        logger.info(`Request includes chatMode: ${chatMode}`);
      }
    }
    
    if (params.thinkingConfig) {
      requestBody.generationConfig.thinkingConfig = params.thinkingConfig;
      logger.info(`Added thinkingConfig to request: ${JSON.stringify(params.thinkingConfig)}`);
    }
    
    // Direct API call to v1alpha endpoint with API key in URL
    const endpoint = `https://generativelanguage.googleapis.com/v1alpha/models/${model}:generateContent?key=${apiKey}`;
    
    // Using node-fetch or native fetch depending on environment
    const fetch = globalThis.fetch;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const data = await response.json();
    
    // Log the full raw response for debugging tool calls
    logger.info(`GEMINI RAW RESPONSE: ${JSON.stringify(data, null, 2)}`);
    
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
          
          // Check for function call formats
          // 1. Check direct functionCall format
          if (part.functionCall) {
            toolCall = {
              name: part.functionCall.name,
              parameters: convertCamelCaseToSnakeCase(part.functionCall.args || {}),
              id: candidate.contentId || 'unknown'
            };
            logger.info(`Detected direct tool call in response: ${toolCall.name}`);
          }
        }
        
        // 2. Check for candidateFunctionCall at candidate level (some Gemini models use this format)
        if (candidate.functionCall) {
          toolCall = {
            name: candidate.functionCall.name,
            parameters: convertCamelCaseToSnakeCase(candidate.functionCall.args || {}),
            id: candidate.contentId || 'unknown'
          };
          logger.info(`Detected candidate-level tool call in response: ${toolCall.name}`);
        }
        
        // 3. Check for legacy function calling format
        if (candidate.content.functionCall) {
          const legacyParams = candidate.content.functionCall.arguments ? 
                              JSON.parse(candidate.content.functionCall.arguments) : {};
          toolCall = {
            name: candidate.content.functionCall.name,
            parameters: convertCamelCaseToSnakeCase(legacyParams),
            id: candidate.contentId || 'unknown'
          };
          logger.info(`Detected legacy tool call in response: ${toolCall.name}`);
        }
        
        // 4. Last resort: check for function call patterns in text content
        if (!toolCall && text) {
          // Look for structured function call patterns in the text
          const functionCallPatterns = [
            // antml:function_calls pattern
            /<function_calls>[\s\S]*?<invoke name="([^"]+)">/,
            // General function call pattern with JSON
            /\{\s*"functionCall"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/,
            // Plain text function call pattern
            /```\s*\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:/
          ];
          
          for (const pattern of functionCallPatterns) {
            const match = text.match(pattern);
            if (match) {
              logger.info(`Found function call pattern in text: ${match[1]}`);
              
              // Extract function call info
              try {
                // Attempt to extract the function name
                const functionName = match[1];
                let parameters = {};
                
                // Try to extract parameters as well
                const paramMatch = text.match(/"parameters":\s*(\{[\s\S]*?\})/);
                if (paramMatch) {
                  try {
                    parameters = JSON.parse(paramMatch[1]);
                  } catch (e) {
                    logger.error(`Failed to parse parameters from text: ${e}`);
                  }
                }
                
                toolCall = {
                  name: functionName,
                  parameters: convertCamelCaseToSnakeCase(parameters),
                  id: `extracted-${Date.now()}`
                };
                
                logger.info(`Extracted toolCall from text: ${JSON.stringify(toolCall, null, 2)}`);
                
                // Remove the function call text from the response
                text = text.replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/, '');
                break;
              } catch (e) {
                logger.error(`Failed to extract function call from text: ${e}`);
              }
            }
          }
        }
      }
    }
    
    // Estimate token usage (Google doesn't provide token counts directly)
    const inputTokens = Math.ceil(messages.reduce((total, message) => total + message.parts.reduce((partTotal, part) => partTotal + (part.text?.length || 0), 0), 0) / 4);
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
  // Declare accumulators at the function scope so they are available in the catch block
  let accumulatedAnswer = ''; // Was completeText
  let accumulatedThoughts = '';
  
  try {
    const { apiKey, model, messages, temperature = 0.7, maxTokens, systemMessage, tools, chatMode } = params;
    const { onStart, onChunk, onReasoningChunk, onError, onComplete } = handlers;
    
    logger.info(`Starting streaming Gemini request with model: ${model}`);
    
    // Call onStart handler
    if (onStart) {
      onStart();
    }
    
    // Format request body
    let requestBody: any = {
      contents: messages,
      generationConfig: {
        temperature,
        ...(maxTokens && { maxOutputTokens: maxTokens })
      }
    };
    
    // Add system message if present
    if (systemMessage) {
      requestBody.systemInstruction = {
        role: 'model',
        parts: [{ text: systemMessage }]
      };
      logger.info(`Added system message to streaming request, length: ${systemMessage.length}`);
    }

    // Add tools if present
    if (tools && Array.isArray(tools) && tools.length > 0) {
      const functionDeclarations = tools.map(tool => {
        const requiredParams = Object.keys(tool.parameters || {});
        const formattedProperties: Record<string, any> = {};

        if (tool.parameters) {
          for (const [key, paramValue] of Object.entries(tool.parameters)) {
            const param = paramValue as { description?: string };
            let paramType = 'STRING';
            const description = param.description || '';
            if (description.toLowerCase().includes('array') || description.includes('[]')) {
              paramType = 'ARRAY';
            } else if (description.toLowerCase().includes('number') || 
                      description.toLowerCase().includes('integer') || 
                      description.includes('count')) {
              paramType = 'NUMBER';
            } else if (description.toLowerCase().includes('boolean') || 
                      description.toLowerCase().includes('true/false')) {
              paramType = 'BOOLEAN';
            }
            
            formattedProperties[key] = {
              type: paramType,
              description: param.description || ''
            };
            
            if (paramType === 'ARRAY') {
              formattedProperties[key].items = { type: 'STRING' };
            }
          }
        }

        return {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'OBJECT',
            properties: formattedProperties,
            required: requiredParams
          }
        };
      });

      requestBody.tools = [{ functionDeclarations }];
      
      logger.info(`Added ${tools.length} tools to streaming request: ${tools.map(t => t.name).join(', ')}`);
      if (tools.length > 0) {
        logger.debug(`Example tool format: ${JSON.stringify(requestBody.tools[0], null, 2)}`);
      }
      
      // Add toolConfig for function calling when in agent mode
      if (chatMode === 'agent') {
        requestBody.toolConfig = {
          functionCallingConfig: {
            // In agent mode, set to 'auto' to allow the model to decide when to use tools
            // This encourages tool usage without forcing it
            mode: 'auto',
          },
        };
        logger.info('Added function calling config for agent mode');
      }
    }

    // If we have a chatMode, log it
    if (chatMode) {
      logger.info(`Streaming request includes chatMode: ${chatMode}`);
    }

    // Add thinkingConfig if present
    if (params.thinkingConfig) {
      requestBody.generationConfig.thinkingConfig = params.thinkingConfig;
      logger.info(`Added thinkingConfig to streaming request: ${JSON.stringify(params.thinkingConfig)}`);
    }

    
    // Direct API call to v1alpha endpoint with API key in URL
    const endpoint = `https://generativelanguage.googleapis.com/v1alpha/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    
    // Using node-fetch or native fetch depending on environment
    const fetch = globalThis.fetch;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    if (!response.body) {
      throw new Error('Response body is null');
    }
    
    // Process the SSE stream with enhanced diagnostics
    // Note: accumulatedAnswer and accumulatedThoughts will be built up here.
    const reader = response.body.getReader();
    let rawResponse = null; // Store the raw response
    const decoder = new TextDecoder();
    let partialLine = ''; // Store partial line if chunk is split mid-JSON
    let partialLineTimeout: NodeJS.Timeout | null = null;
    const MAX_PARTIAL_LINE_WAIT = 30000; // Increased from 15000ms to 30000ms for better reliability
    
    // Enhanced stream diagnostics
    const streamDiagnostics = {
      totalBytesReceived: 0,
      totalChunksReceived: 0,
      linesProcessed: 0,
      jsonParseErrors: 0,
      lastChunkTime: Date.now(),
      largestChunkSize: 0,
      streamStartTime: Date.now(),
      partialLineOccurrences: 0,
      errorChunksDetected: 0
    };
    
    logger.info(`GEMINI STREAM DIAGNOSTICS: Starting stream processing for model ${model}`);
    
    // Helper function to handle partial line timeouts with retry capability
    const setupPartialLineTimeout = () => {
      // Clear any existing timeout
      if (partialLineTimeout) {
        clearTimeout(partialLineTimeout);
      }
      
      // Set new timeout - increased from 15s to 30s for better reliability
      partialLineTimeout = setTimeout(() => {
        if (partialLine) {
          streamDiagnostics.partialLineOccurrences++;
          logger.warn(`GEMINI STREAM DIAGNOSTICS: Partial line timeout #${streamDiagnostics.partialLineOccurrences} after ${MAX_PARTIAL_LINE_WAIT}ms: ${partialLine.substring(0, 50)}...`);
          
          // Enhanced timeout handling - try multiple recovery strategies
          try {
            // Strategy 1: Try to parse as-is
            const parsedPartial = JSON.parse(partialLine);
            logger.info(`GEMINI STREAM DIAGNOSTICS: Strategy 1 successful - parsed timed-out partial line`);
            
            // Process successful parse
            if (parsedPartial.candidates && parsedPartial.candidates[0]?.content?.parts) {
              for (const part of parsedPartial.candidates[0].content.parts) {
                if (part.text) {
                  if (part.thought === true) {
                    accumulatedThoughts += part.text;
                    if (onReasoningChunk) {
                      onReasoningChunk(part.text);
                    }
                  } else {
                    accumulatedAnswer += part.text;
                    handlers.onChunk(part.text);
                  }
                }
              }
            }
          } catch (parseError) {
            logger.warn(`GEMINI STREAM DIAGNOSTICS: Strategy 1 failed: ${parseError}. Trying text extraction...`);
            
            // Strategy 2: Try to extract text content even from malformed JSON
            const textMatches = partialLine.match(/"text":\s*"([^"]*)/g);
            if (textMatches && textMatches.length > 0) {
              for (const match of textMatches) {
                const textMatch = match.match(/"text":\s*"([^"]*)/);
                if (textMatch && textMatch[1]) {
                  const extractedText = textMatch[1];
                  logger.info(`GEMINI STREAM DIAGNOSTICS: Strategy 2 successful - extracted text "${extractedText.substring(0, 30)}..."`);
                  accumulatedAnswer += extractedText;
                  handlers.onChunk(extractedText);
                }
              }
            } else {
              logger.warn(`GEMINI STREAM DIAGNOSTICS: Strategy 2 failed - no text found. Final attempt with regex...`);
              
              // Strategy 3: Try to find any quoted text content
              const anyTextMatch = partialLine.match(/"([^"]{10,})"/);
              if (anyTextMatch && anyTextMatch[1]) {
                const potentialText = anyTextMatch[1];
                // Only use if it looks like actual content (not just JSON keys)
                if (!potentialText.match(/^(text|thought|candidates|parts|content)$/)) {
                  logger.info(`GEMINI STREAM DIAGNOSTICS: Strategy 3 - extracted potential content "${potentialText.substring(0, 30)}..."`);
                  accumulatedAnswer += potentialText;
                  handlers.onChunk(potentialText);
                }
              }
            }
          }
          
          partialLine = ''; // Clear the partial line after processing
        }
      }, MAX_PARTIAL_LINE_WAIT);
    };
    
    let chunk;
    while (!(chunk = await reader.read()).done) {
      try {
        const rawText = decoder.decode(chunk.value, { stream: true });
        
        // Enhanced diagnostics
        streamDiagnostics.totalBytesReceived += rawText.length;
        streamDiagnostics.totalChunksReceived++;
        streamDiagnostics.lastChunkTime = Date.now();
        streamDiagnostics.largestChunkSize = Math.max(streamDiagnostics.largestChunkSize, rawText.length);
        
        // Log raw SSE data for debugging with enhanced info
        logger.debug(`GEMINI STREAM DIAGNOSTICS: Chunk #${streamDiagnostics.totalChunksReceived} received (${rawText.length} bytes, total: ${streamDiagnostics.totalBytesReceived})`);
        
        // Check for error indicators in raw text
        if (rawText.includes('"error"') || rawText.includes('"code":')) {
          streamDiagnostics.errorChunksDetected++;
          logger.warn(`GEMINI STREAM DIAGNOSTICS: Error chunk detected #${streamDiagnostics.errorChunksDetected}: ${rawText.substring(0, 200)}...`);
        }
        
        // Combine with any previous partial line
        const textToParse = partialLine + rawText;
        partialLine = ''; // Reset for this iteration
        
        // Clear timeout since we're processing the partial line
        if (partialLineTimeout) {
          clearTimeout(partialLineTimeout);
          partialLineTimeout = null;
        }
        
        // Parse SSE format (data: {json})
        const lines = textToParse.split('\n');
        let lineIdx = 0;
        
        while (lineIdx < lines.length) {
          const line = lines[lineIdx].trim();
          lineIdx++;
          
          if (line === '') continue;
          
          streamDiagnostics.linesProcessed++;
          
          if (line.startsWith('data: ')) {
            try {
              // Skip "[DONE]" message at the end
              if (line === 'data: [DONE]') {
                logger.info('GEMINI STREAM DIAGNOSTICS: Received [DONE] message from SSE stream');
                continue;
              }
              
              const jsonText = line.slice(6); // Remove "data: " prefix
              
              // Try to parse the JSON
              try {
                const data = JSON.parse(jsonText);
                
                // Enhanced logging for debugging with size info
                const dataStr = JSON.stringify(data);
                logger.info(`GEMINI STREAM DIAGNOSTICS: Successfully parsed chunk #${streamDiagnostics.linesProcessed} (${dataStr.length} chars): ${dataStr.substring(0, 150)}...`);
                
                // Store the raw response data (will use the last chunk)
                rawResponse = data;
                
                // Check for API errors in this chunk
                if (data.error) {
                  logger.error(`GEMINI STREAM DIAGNOSTICS: API error detected in chunk: ${JSON.stringify(data.error)}`);
                  streamDiagnostics.errorChunksDetected++;
                }
                
                // Extract text content, differentiating thoughts and answers
                if (data.candidates && 
                    data.candidates[0]?.content?.parts && 
                    data.candidates[0].content.parts.length > 0) {
                  
                  let thoughtChunkForThisSSEEvent = '';
                  let answerChunkForThisSSEEvent = '';

                  for (const part of data.candidates[0].content.parts) {
                    if (part.text) {
                      // The 'thought' property is a boolean indicating if the part is a thought summary
                      if (part.thought === true) { 
                        thoughtChunkForThisSSEEvent += part.text;
                      } else {
                        answerChunkForThisSSEEvent += part.text;
                      }
                    }
                  }
                  
                  if (thoughtChunkForThisSSEEvent) {
                    accumulatedThoughts += thoughtChunkForThisSSEEvent;
                    // Stream reasoning chunks separately if handler is provided
                    if (onReasoningChunk) {
                      onReasoningChunk(thoughtChunkForThisSSEEvent);
                    }
                    logger.debug(`GEMINI STREAM DIAGNOSTICS: Processed ${thoughtChunkForThisSSEEvent.length} chars of reasoning`);
                  }
                  if (answerChunkForThisSSEEvent) {
                    accumulatedAnswer += answerChunkForThisSSEEvent;
                    // Stream regular content chunks immediately without artificial delays
                    handlers.onChunk(answerChunkForThisSSEEvent);
                    logger.debug(`GEMINI STREAM DIAGNOSTICS: Processed ${answerChunkForThisSSEEvent.length} chars of answer`);
                  }
                }
              } catch (jsonError) {
                // Enhanced JSON error handling with diagnostics
                streamDiagnostics.jsonParseErrors++;
                const errorMessage = jsonError instanceof Error ? jsonError.message : String(jsonError);
                logger.debug(`GEMINI STREAM DIAGNOSTICS: JSON parse error #${streamDiagnostics.jsonParseErrors} (chunk #${streamDiagnostics.linesProcessed}): ${errorMessage}`);
                
                // This could be an incomplete JSON chunk
                // Store it and try to combine with the next chunk
                logger.debug(`GEMINI STREAM DIAGNOSTICS: Incomplete JSON detected, buffering ${jsonText.length} chars: ${jsonText.substring(0, 50)}...`);
                
                // If we already have a partial line, append to it
                if (partialLine) {
                  partialLine += jsonText;
                  logger.debug(`GEMINI STREAM DIAGNOSTICS: Appended to existing partial line, now ${partialLine.length} chars total`);
                } else {
                  partialLine = jsonText;
                  logger.debug(`GEMINI STREAM DIAGNOSTICS: Started new partial line with ${partialLine.length} chars`);
                }
                
                // Set up timeout to prevent hanging if we don't get the rest of the JSON
                setupPartialLineTimeout();
                
                // Don't break the stream for JSON parse errors - this is expected behavior
                if (errorMessage === 'Unexpected end of JSON input') {
                  logger.debug('GEMINI STREAM DIAGNOSTICS: Standard incomplete chunk behavior');
                } else {
                  logger.warn(`GEMINI STREAM DIAGNOSTICS: Unusual JSON error: ${errorMessage}`);
                }
              }
            } catch (error) {
              logger.error(`GEMINI STREAM DIAGNOSTICS: Error processing SSE data line: ${error}`);
              // Don't throw errors here to keep the stream going
            }
          } else if (line.startsWith('event:')) {
            // Handle SSE events according to spec (https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
            logger.info(`GEMINI STREAM DIAGNOSTICS: Received SSE event: ${line.slice(6).trim()}`);
          } else if (line.startsWith('id:')) {
            // Handle SSE event ID
            logger.info(`GEMINI STREAM DIAGNOSTICS: Received SSE ID: ${line.slice(3).trim()}`);
          } else if (line.startsWith(':')) {
            // This is a comment, typically used as a keep-alive
            logger.debug(`GEMINI STREAM DIAGNOSTICS: Received SSE comment: ${line.slice(1).trim()}`);
          } else {
            // This might be a continuation of a previous line that was split
            // Add it to partialLine if it looks like it could be part of JSON
            if (line.includes('{') || line.includes('}') || line.includes('"')) {
              partialLine += line;
              logger.debug(`GEMINI STREAM DIAGNOSTICS: Added orphaned line to partial buffer: ${line.substring(0, 50)}...`);
              // Set up timeout when we detect a partial line
              setupPartialLineTimeout();
            } else {
              logger.warn(`GEMINI STREAM DIAGNOSTICS: Ignoring unrecognized line: ${line.substring(0, 50)}...`);
            }
          }
        }
      } catch (streamError) {
        // Enhanced stream error logging
        logger.error(`GEMINI STREAM DIAGNOSTICS: Error processing stream chunk #${streamDiagnostics.totalChunksReceived}: ${streamError}`);
        logger.error(`GEMINI STREAM DIAGNOSTICS: Stream stats at error - Bytes: ${streamDiagnostics.totalBytesReceived}, Chunks: ${streamDiagnostics.totalChunksReceived}, Lines: ${streamDiagnostics.linesProcessed}, JSON Errors: ${streamDiagnostics.jsonParseErrors}`);
        // Continue processing to maintain stream resilience, but don't break the flow
      }
    }
    
    // Final diagnostics summary
    const totalElapsedMs = Date.now() - streamDiagnostics.streamStartTime;
    logger.info(
      `GEMINI STREAM DIAGNOSTICS: Stream completed - ` +
      `${streamDiagnostics.totalChunksReceived} chunks, ` +
      `${streamDiagnostics.totalBytesReceived} bytes, ` +
      `${streamDiagnostics.linesProcessed} lines processed, ` +
      `${streamDiagnostics.jsonParseErrors} JSON errors, ` +
      `${streamDiagnostics.partialLineOccurrences} partial line timeouts, ` +
      `${streamDiagnostics.errorChunksDetected} error chunks, ` +
      `${totalElapsedMs}ms total, ` +
      `largest chunk: ${streamDiagnostics.largestChunkSize} bytes`
    );
    
    // Clean up any remaining timeout
    if (partialLineTimeout) {
      clearTimeout(partialLineTimeout);
      partialLineTimeout = null;
    }
    
    // Enhanced partial line handling with better error recovery
    if (partialLine) {
      logger.warn(`Stream ended with remaining partial line: ${partialLine.substring(0, 100)}...`);
      
      // First, try to detect if this is a truncated error response from Gemini API
      if (partialLine.includes('"error"') && partialLine.includes('"code"')) {
        logger.error(`Detected truncated error response from Gemini API: ${partialLine.substring(0, 200)}...`);
        
        // Try to extract what we can from the partial error
        let errorCode = 'GEMINI_API_ERROR';
        let errorMessage = 'Gemini API returned an error but the response was truncated';
        
        const codeMatch = partialLine.match(/"code":\s*(\d+)/);
        if (codeMatch) {
          errorCode = `GEMINI_${codeMatch[1]}`;
        }
        
        const messageMatch = partialLine.match(/"message":\s*"([^"]*)/);
        if (messageMatch) {
          errorMessage = messageMatch[1];
          // If message seems incomplete, indicate truncation
          if (!partialLine.includes(messageMatch[1] + '"')) {
            errorMessage += ' [response truncated]';
          }
        }
        
        // Throw a proper error that will be caught by the outer try-catch
        throw new Error(`${errorMessage} (Code: ${errorCode})`);
      }
      
      // Try to parse as complete JSON first
      try {
        const parsedPartial = JSON.parse(partialLine);
        rawResponse = parsedPartial;
        logger.info(`Successfully parsed final partial line as complete JSON`);

        if (parsedPartial.error) {
          logger.error(`Error detected in final parsed partial line: ${JSON.stringify(parsedPartial.error)}`);
          // Clear accumulated content since we have an API error
          accumulatedAnswer = ''; 
          accumulatedThoughts = '';
          throw new Error(`Gemini API Error: ${parsedPartial.error.message || 'Unknown error'} (Code: ${parsedPartial.error.code || 'Unknown'})`);
        } else if (parsedPartial.candidates && parsedPartial.candidates[0]?.content?.parts) {
          // Process valid content normally
          let finalThoughtChunk = '';
          let finalAnswerChunk = '';
          for (const part of parsedPartial.candidates[0].content.parts) {
            if (part.text) {
              if (part.thought === true) {
                finalThoughtChunk += part.text;
              } else {
                finalAnswerChunk += part.text;
              }
            }
          }
          if (finalThoughtChunk) {
            logger.info(`Extracted thoughts from final parsed partial line: ${finalThoughtChunk.substring(0, 50)}...`);
            accumulatedThoughts += finalThoughtChunk;
          }
          if (finalAnswerChunk) {
            logger.info(`Extracted answer from final parsed partial line: ${finalAnswerChunk.substring(0, 50)}...`);
            handlers.onChunk(finalAnswerChunk); 
            accumulatedAnswer += finalAnswerChunk;
          }
        }
      } catch (jsonError) {
        // JSON parsing failed, try text extraction as fallback
        logger.warn(`Final partial line is not valid JSON, attempting text extraction: ${jsonError}`);
        
        // Only attempt text extraction if this doesn't look like an error response
        if (!partialLine.toLowerCase().includes('"error"') && !partialLine.includes('"code"')) {
          const textMatch = partialLine.match(/"text":\s*"([^"]*)"/);
          if (textMatch && textMatch[1]) {
            const extractedText = textMatch[1];
            logger.info(`Extracted text via regex from non-JSON final partial line: ${extractedText}`);
            handlers.onChunk(extractedText);
            accumulatedAnswer += extractedText;
          } else {
            logger.warn(`Could not extract any useful content from partial line, discarding: ${partialLine.substring(0, 100)}...`);
          }
        } else {
          // This looks like a truncated error response
          logger.error(`Truncated error response detected in partial line: ${partialLine.substring(0, 150)}`);
          throw new Error(`Gemini API error response was truncated. Partial response: ${partialLine.substring(0, 100)}...`);
        }
      }
    }
    
    // Remove artificial delays - they can cause premature termination
    
    if (!rawResponse && (accumulatedAnswer || accumulatedThoughts)) {
      logger.warn(`Stream completed without a valid raw response despite receiving text. Answer Length: ${accumulatedAnswer.length}, Thoughts Length: ${accumulatedThoughts.length}`);
    }
    
    const inputTokens = Math.ceil(messages.reduce((total, message) => total + message.parts.reduce((partTotal, part) => partTotal + (part.text?.length || 0), 0), 0) / 4);
    const outputTokens = Math.ceil(accumulatedAnswer.length / 4);
    const thoughtsTokens = rawResponse?.usageMetadata?.thoughtsTokenCount || Math.ceil(accumulatedThoughts.length / 4); // Estimate if not provided
    const totalTokens = inputTokens + outputTokens + thoughtsTokens;
    
    logger.info(`Gemini stream completed. Input Tokens: ${inputTokens}, Output Tokens (Answer): ${outputTokens}, Thoughts Tokens: ${thoughtsTokens}, Total: ${totalTokens}`);
    
    const responseObj: LLMResponse = {
      text: accumulatedAnswer.trim(),
      tokensUsed: totalTokens,
      creditsUsed: totalTokens / 1000, 
      success: true,
      generatedText: accumulatedAnswer.trim(),
      rawResponse: rawResponse,
      reasoning: accumulatedThoughts.trim(), // Primarily from thoughts
      toolCall: undefined,
      waitingForToolCall: false,
      // Add thoughtsTokenCount if LLMResponse type is updated to support it
      // thoughtsTokenCount: thoughtsTokens 
    };

    // Tool call processing - operates on accumulatedAnswer if thoughts didn't cover reasoning
    let tempReasoningForToolCall = accumulatedThoughts.trim();
    let textToSearchForToolCall = accumulatedAnswer.trim();

    if (rawResponse && 
        rawResponse.candidates && 
        rawResponse.candidates[0]?.content?.parts) {
      
      logger.info(`RAW RESPONSE STRUCTURE (for tool call processing): ${JSON.stringify({
        hasContent: !!rawResponse.candidates[0].content,
        contentParts: rawResponse.candidates[0].content?.parts?.length,
        hasToolCallInParts: rawResponse.candidates[0].content?.parts?.some((p: any) => p.functionCall),
        hasCandidateLevelToolCall: !!rawResponse.candidates[0].functionCall
      }, null, 2)}`);
      
      let toolCallFoundInParts = false;
      for (const part of rawResponse.candidates[0].content.parts) {
        if (part.functionCall) {
          logger.info(`Found functionCall in part: ${JSON.stringify(part.functionCall, null, 2)}`);
          
          // If thoughts are present, they are the reasoning.
          // If not, text before this tool call part (from accumulatedAnswer) is reasoning.
          if (!tempReasoningForToolCall) {
             // This implies the text leading to the tool call was part of 'accumulatedAnswer'
             // We need to find where in 'accumulatedAnswer' this tool call 'part' begins.
             // This is complex. For now, if no thoughts, assume all of 'accumulatedAnswer' before this part's text is reasoning.
             tempReasoningForToolCall = textToSearchForToolCall;
          }

          responseObj.toolCall = {
            name: part.functionCall.name,
            parameters: convertCamelCaseToSnakeCase(part.functionCall.args || {}),
            id: rawResponse.candidates[0].contentId || `fc-${Date.now()}`
          };
          
          let toolCallPartText = '';
          if (part.text) { // Text directly associated with this tool call part
            toolCallPartText = part.text.trim();
            // If this part's text was part of textToSearchForToolCall, adjust reasoning.
            if (tempReasoningForToolCall.endsWith(toolCallPartText)) {
                tempReasoningForToolCall = tempReasoningForToolCall.slice(0, -toolCallPartText.length).trim();
            }
          }
          responseObj.text = toolCallPartText; // Main text is only what's in this part if tool call found
          responseObj.generatedText = toolCallPartText;


          
          responseObj.waitingForToolCall = true;
          toolCallFoundInParts = true;
          logger.info(`Set toolCall from part.functionCall. Reasoning (final): "${tempReasoningForToolCall}", Text: "${responseObj.text}"`);
          break; 
        }
      }
      
      if (!toolCallFoundInParts && textToSearchForToolCall && !responseObj.toolCall) { // only if no thoughts and no tool call in parts
        const functionCallPatterns = [
          /<function_calls>[\s\S]*?<invoke name="([^\"]+)">/,
          /\{\s*"functionCall"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^\"]+)"/,
          /```\s*\{\s*"name"\s*:\s*"([^\"]+)"\s*,\s*"args"\s*:/
        ];
        for (const pattern of functionCallPatterns) {
          const match = textToSearchForToolCall.match(pattern);
          if (match && match[0]) {
            logger.info(`Found function call pattern in accumulatedAnswer: ${match[1]}`);
            try {
              tempReasoningForToolCall = textToSearchForToolCall.trim(); // All of accumulatedAnswer is reasoning
              responseObj.text = textToSearchForToolCall.replace(match[0], '').trim();
              responseObj.generatedText = responseObj.text;
              
              const functionName = match[1];
              let parameters = {};
              const paramMatch = textToSearchForToolCall.match(/"parameters":\s*(\{[\s\S]*?\})/);
              if (paramMatch && paramMatch[1]) { try { parameters = JSON.parse(paramMatch[1]); } catch (e) { logger.error(`Failed to parse parameters from text: ${e}`); } }
              
              responseObj.toolCall = { name: functionName, parameters: convertCamelCaseToSnakeCase(parameters), id: `extracted-${Date.now()}` };
              responseObj.waitingForToolCall = true;
              toolCallFoundInParts = true;
              logger.info(`Extracted toolCall from text. Reasoning (final): "${tempReasoningForToolCall}", Text: "${responseObj.text}"`);
              break;
            } catch (e) { logger.error(`Failed to extract toolCall from text: ${e}`); }
          }
        }
      }
      
      if (!toolCallFoundInParts && !responseObj.toolCall && rawResponse.candidates[0].functionCall) {
        logger.info(`Found candidate-level functionCall: ${JSON.stringify(rawResponse.candidates[0].functionCall, null, 2)}`);
        tempReasoningForToolCall = textToSearchForToolCall.trim(); // All of accumulatedAnswer is reasoning if no thoughts
        responseObj.text = ''; 
        responseObj.generatedText = '';
        responseObj.toolCall = {
          name: rawResponse.candidates[0].functionCall.name,
          parameters: convertCamelCaseToSnakeCase(rawResponse.candidates[0].functionCall.args || {}),
          id: rawResponse.candidates[0].contentId || `cand-fc-${Date.now()}`
        };

        responseObj.waitingForToolCall = true;
        logger.info(`Set candidate-level toolCall. Reasoning (final): "${tempReasoningForToolCall}", Text: "${responseObj.text}"`);
      }
    }

    // Final assignment of reasoning
    responseObj.reasoning = tempReasoningForToolCall; // This now holds either thoughts or text-before-tool-call

    // Ensure reasoning is at least an empty string if tool call exists but reasoning is still undefined/empty
    if (responseObj.toolCall && !responseObj.reasoning) {
        responseObj.reasoning = "";
    }
    // If no tool call, and no thoughts, reasoning should be undefined as per original logic for pure text responses
    if (!responseObj.toolCall && !accumulatedThoughts.trim()) {
        responseObj.reasoning = undefined;
    }

    logger.info(`FINAL RESPONSE PREP: ToolCall: ${!!responseObj.toolCall}, Reasoning Length: ${responseObj.reasoning?.length || 0}, Text Length: ${responseObj.text?.length || 0}`);

    handlers.onComplete(responseObj as LLMResponse);
  } catch (error) {
    logger.error(`Error in Gemini stream: ${error instanceof Error ? error.message : String(error)}`);
    
    if (accumulatedAnswer || accumulatedThoughts) {
      logger.info(`Despite stream error, returning collected content. Answer length ${accumulatedAnswer.length}, Thoughts length ${accumulatedThoughts.length}`);
      const errorResponse: LLMResponse = {
        text: accumulatedAnswer,
        reasoning: accumulatedThoughts,
        tokensUsed: Math.ceil((accumulatedAnswer.length + accumulatedThoughts.length) / 4),
        success: false,
        error: error instanceof Error ? error.message : String(error),
        generatedText: accumulatedAnswer // Use accumulatedAnswer for generatedText in error cases
      };
      handlers.onComplete(errorResponse);
    } else {
      // If we have no content at all, pass the error to the error handler
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * List available Gemini models dynamically from the API
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
    // Use v1alpha endpoint for model listing
    const response = await fetch('https://generativelanguage.googleapis.com/v1alpha/models', {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error(`Failed to fetch Gemini models: ${response.status} ${response.statusText}`);
      // Return fallback models if API call fails
      return getFallbackGeminiModels();
    }

    const data = await response.json();
    
    if (!data.models || !Array.isArray(data.models)) {
      logger.warn('Invalid response format from Gemini models API, using fallback models');
      return getFallbackGeminiModels();
    }

    const availableModels = data.models
      .filter((model: any) => {
        logger.info(`Inspecting Gemini model from API: ${JSON.stringify(model, null, 2)}`);
        const isSupported = model.supportedGenerationMethods?.includes('generateContent');
        const isNotDeprecated = !(model.description?.toLowerCase().includes('deprecated') || model.displayName?.toLowerCase().includes('deprecated'));
        const isNotEmbedding = !model.name.includes('embedding') && !model.displayName?.toLowerCase().includes('embedding');
        const isChatModel = model.name.includes('gemini');
        
        return isSupported && isNotDeprecated && isNotEmbedding && isChatModel;
      })
      .map((model: any) => {
        const features = ['chat'];
        if (model.name.includes('flash')) features.push('fast');
        if (model.name.includes('pro')) features.push('advanced');
        if (model.name.includes('vision') || model.description?.toLowerCase().includes('multimodal')) {
            features.push('vision');
        }
        if (model.inputTokenLimit > 200000) {
            features.push('long-context');
        }
        if (model.name.includes('1.5') || model.name.includes('2.0') || model.name.includes('2.5')) {
            features.push('tools');
        }

        return {
          id: model.name.replace('models/', ''),
          name: model.displayName,
          provider: 'gemini',
          available: true,
          contextWindow: model.inputTokenLimit || 128000,
          maxOutputTokens: model.outputTokenLimit || 8192,
          features: [...new Set(features)], // remove duplicate features
        };
      })
      // remove duplicates by name
      .filter((model: any, index: number, self: any[]) =>
        index === self.findIndex((t: any) => t.name === model.name)
      )
      .sort((a: any, b: any) => a.name.localeCompare(b.name));


    logger.info(`Successfully fetched ${availableModels.length} Gemini models from API`);
    return availableModels.length > 0 ? availableModels : getFallbackGeminiModels();

  } catch (error) {
    logger.error(`Error fetching Gemini models: ${error instanceof Error ? error.message : String(error)}`);
    return getFallbackGeminiModels();
  }
}

/**
 * Fallback models in case API call fails
 */
function getFallbackGeminiModels(): Array<{ 
  id: string; 
  name: string; 
  provider: string;
  available: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  features: string[];
}> {
  return [
    {
      id: 'gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      provider: 'gemini',
      available: true,
      contextWindow: 128000,
      maxOutputTokens: 8192,
      features: ['chat', 'tools', 'thinking', 'fast']
    },
    {
      id: 'gemini-1.5-flash',
      name: 'Gemini 1.5 Flash',
      provider: 'gemini',
      available: true,
      contextWindow: 1048576,
      maxOutputTokens: 8192,
      features: ['chat', 'tools', 'vision', 'code', 'fast']
    },
    {
      id: 'gemini-1.5-pro',
      name: 'Gemini 1.5 Pro',
      provider: 'gemini',
      available: true,
      contextWindow: 2097152,
      maxOutputTokens: 8192,
      features: ['chat', 'tools', 'vision', 'code', 'advanced']
    }
  ];
}

/**
 * Send a message to Gemini with streaming support
 * This is used by the WebSocket server to handle client requests
 */
export async function streamGeminiMessage(params: {
  apiKey: string;
  model: string;
  messages: GeminiMessage[];
  temperature?: number;
  maxTokens?: number;
  systemMessage?: string;
  tools?: any[];
  chatMode?: 'normal' | 'gather' | 'agent';
  thinkingConfig?: ThinkingConfig;
  onStart?: () => void;
  onChunk: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  onError: (error: Error) => void;
  onComplete: (response: LLMResponse) => void;
}): Promise<void> {
  try {
    await sendStreamingRequest(params, {
      onStart: params.onStart,
      onChunk: params.onChunk,
      onReasoningChunk: params.onReasoningChunk,
      onError: params.onError,
      onComplete: params.onComplete
    });
  } catch (error) {
    params.onError(error as Error);
  }
}

/**
 * Send a message to Gemini without streaming
 * This is used by the WebSocket server to handle client requests
 */
export async function sendGeminiMessage(params: {
  apiKey: string;
  model: string;
  messages: GeminiMessage[];
  temperature?: number;
  maxTokens?: number;
  systemMessage?: string;
  tools?: any[];
  chatMode?: 'normal' | 'gather' | 'agent';
  thinkingConfig?: ThinkingConfig;
}): Promise<LLMResponse> {
  return await sendRequest(params);
}

/**
 * Generate embeddings using Gemini's text embedding model
 */
export async function generateEmbedding(params: {
  apiKey: string;
  content: string;
  model?: string;
  apiVersion?: 'v1beta' | 'v1alpha';
}): Promise<{
  embedding: number[];
  tokensUsed: number;
  model: string;
  error?: string;
}> {
  const { apiKey, content, model = 'text-embedding-004', apiVersion = 'v1alpha' } = params;
  
  try {
    logger.info(`Generating embedding with model: ${model}, API version: ${apiVersion}`);
    
    // Use v1alpha for all models as it provides better features
    const endpoint = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:embedContent?key=${apiKey}`;
    
    const requestBody = {
      model: `models/${model}`,
      content: {
        parts: [{
          text: content
        }]
      }
    };
    
    const fetch = globalThis.fetch;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini Embedding API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data.embedding || !data.embedding.values) {
      throw new Error('Invalid embedding response format');
    }
    
    // Estimate tokens (Gemini doesn't provide token count for embeddings)
    const estimatedTokens = Math.ceil(content.length / 4);
    
    return {
      embedding: data.embedding.values,
      tokensUsed: estimatedTokens,
      model: model
    };
  } catch (error) {
    logger.error('Error generating embedding:', error);
    return {
      embedding: [],
      tokensUsed: 0,
      model: model,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Generate embeddings for multiple texts in batch
 */
export async function generateBatchEmbeddings(params: {
  apiKey: string;
  contents: Array<{ id: string; content: string }>;
  model?: string;
  batchSize?: number;
  apiVersion?: 'v1beta' | 'v1alpha';
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
  const { apiKey, contents, model = 'text-embedding-004', batchSize = 5, apiVersion = 'v1alpha' } = params;
  
  logger.info(`Generating batch embeddings for ${contents.length} items with batch size ${batchSize}, API version: ${apiVersion}`);
  
  const results: Array<{
    id: string;
    embedding: number[];
    tokensUsed: number;
    error?: string;
  }> = [];
  
  let totalTokensUsed = 0;
  
  // Process in batches to avoid rate limits
  for (let i = 0; i < contents.length; i += batchSize) {
    const batch = contents.slice(i, i + batchSize);
    
    // Process batch sequentially (not in parallel) to avoid rate limits
    for (const item of batch) {
      try {
        const result = await generateEmbedding({
          apiKey,
          content: item.content,
          model,
          apiVersion
        });
        
        results.push({
          id: item.id,
          embedding: result.embedding,
          tokensUsed: result.tokensUsed,
          error: result.error
        });
        
        totalTokensUsed += result.tokensUsed;
        
        // Add delay between individual requests within a batch
        if (batch.indexOf(item) < batch.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between requests
        }
      } catch (error) {
        logger.error(`Error generating embedding for item ${item.id}:`, error);
        results.push({
          id: item.id,
          embedding: [],
          tokensUsed: 0,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    // Add longer delay between batches
    if (i + batchSize < contents.length) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay between batches
    }
    
    logger.info(`Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(contents.length / batchSize)}`);
  }
  
  return {
    embeddings: results,
    totalTokensUsed,
    model
  };
}

/**
 * Generate a grounded answer using Gemini's Semantic Retrieval API
 * This provides a hosted question answering service for RAG systems
 */
export async function generateAnswer(params: {
  apiKey: string;
  model: string;
  query: string;
  passages: Array<{ id: string; content: string }>;
  answerStyle?: 'ABSTRACTIVE' | 'EXTRACTIVE' | 'VERBOSE';
  temperature?: number;
  maxChunksCount?: number;
  minimumRelevanceScore?: number;
}): Promise<{
  answer: string;
  answerableProbability: number;
  sources: Array<{ id: string; relevanceScore?: number }>;
  tokensUsed: number;
  error?: string;
}> {
  const { 
    apiKey, 
    model, 
    query, 
    passages, 
    answerStyle = 'ABSTRACTIVE',
    temperature = 0.2,
    maxChunksCount = 10,
    minimumRelevanceScore = 0.5
  } = params;
  
  try {
    logger.info(`Generating answer with Semantic Retrieval API, model: ${model}, passages: ${passages.length}`);
    
    // Semantic Retrieval API endpoint
    const endpoint = `https://generativelanguage.googleapis.com/v1alpha/models/${model}:generateAnswer?key=${apiKey}`;
    
    const requestBody = {
      contents: [{
        role: 'user',
        parts: [{ text: query }]
      }],
      answerStyle: answerStyle,
      temperature: temperature,
      grounding_source: {
        inlinePassages: {
          passages: passages.map(passage => ({
            id: passage.id,
            content: {
              parts: [{ text: passage.content }]
            }
          }))
        }
      }
    };
    
    const fetch = globalThis.fetch;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini Semantic Retrieval API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data.answer || !data.answer.content || !data.answer.content.parts) {
      throw new Error('Invalid semantic retrieval response format');
    }
    
    // Extract answer text
    const answerText = data.answer.content.parts
      .filter((part: any) => part.text)
      .map((part: any) => part.text)
      .join('');
    
    // Extract source citations if available
    const sources: Array<{ id: string; relevanceScore?: number }> = [];
    if (data.answer.citationMetadata && data.answer.citationMetadata.citationSources) {
      for (const citation of data.answer.citationMetadata.citationSources) {
        if (citation.uri) {
          // Extract passage ID from URI if it matches our format
          const passageId = citation.uri.replace(/^passage:/, '');
          sources.push({
            id: passageId,
            relevanceScore: citation.relevanceScore
          });
        }
      }
    }
    
    // Estimate tokens
    const estimatedTokens = Math.ceil((query.length + answerText.length) / 4);
    
    return {
      answer: answerText,
      answerableProbability: data.answerableProbability || 0,
      sources: sources,
      tokensUsed: estimatedTokens
    };
  } catch (error) {
    logger.error('Error generating semantic retrieval answer:', error);
    return {
      answer: '',
      answerableProbability: 0,
      sources: [],
      tokensUsed: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export default {
  sendRequest,
  sendStreamingRequest,
  listModels,
  streamGeminiMessage,
  sendGeminiMessage,
  generateEmbedding,
  generateBatchEmbeddings,
  getModelConfig,
  estimateTokenCount,
  generateAnswer
};
