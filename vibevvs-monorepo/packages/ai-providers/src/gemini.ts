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
  prompt: string;
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
  onError: (error: Error) => void;
  onComplete: (response: LLMResponse) => void;
}

/**
 * Send a request to the Gemini API
 */
export async function sendRequest(params: GeminiRequestParams): Promise<LLMResponse> {
  try {
    const { apiKey, model, prompt, temperature = 0.7, maxTokens, systemMessage, tools, chatMode } = params;
    
    logger.info(`Starting Gemini request with model: ${model}`);
    
    // Format request body
    let requestBody: any = {
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
    
    // Add system message if present
    if (systemMessage) {
      // For Gemini API, we prefix system messages to user messages
      let enhancedSystemMessage = systemMessage;
      
      // If we have tools and a chatMode, explicitly tell the model what mode it's in
      if (tools && tools.length > 0 && chatMode) {
        logger.info(`Adding chatMode (${chatMode}) context to system message`);
        enhancedSystemMessage = `${systemMessage}\n\nIMPORTANT: You are currently in ${chatMode} mode and have access to the tools provided. In agent mode, you SHOULD use all available tools including file creation and editing tools.`;
      }
      
      requestBody.contents[0].parts[0].text = `${enhancedSystemMessage}\n\n${prompt}`;
      logger.info(`Added system message to request, total prompt length: ${requestBody.contents[0].parts[0].text.length}`);
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
    
    // Direct API call to v1beta endpoint with API key in URL
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
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
              parameters: part.functionCall.args || {},
              id: candidate.contentId || 'unknown'
            };
            logger.info(`Detected direct tool call in response: ${toolCall.name}`);
          }
        }
        
        // 2. Check for candidateFunctionCall at candidate level (some Gemini models use this format)
        if (candidate.functionCall) {
          toolCall = {
            name: candidate.functionCall.name,
            parameters: candidate.functionCall.args || {},
            id: candidate.contentId || 'unknown'
          };
          logger.info(`Detected candidate-level tool call in response: ${toolCall.name}`);
        }
        
        // 3. Check for legacy function calling format
        if (candidate.content.functionCall) {
          toolCall = {
            name: candidate.content.functionCall.name,
            parameters: candidate.content.functionCall.arguments ? 
                       JSON.parse(candidate.content.functionCall.arguments) : {},
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
                  parameters: parameters,
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
  // Declare accumulators at the function scope so they are available in the catch block
  let accumulatedAnswer = ''; // Was completeText
  let accumulatedThoughts = '';
  
  try {
    const { apiKey, model, prompt, temperature = 0.7, maxTokens, systemMessage, tools, chatMode } = params;
    const { onStart, onChunk, onError, onComplete } = handlers;
    
    logger.info(`Starting streaming Gemini request with model: ${model}`);
    
    // Call onStart handler
    if (onStart) {
      onStart();
    }
    
    // Format request body
    let requestBody: any = {
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
    
    // Add system message if present
    if (systemMessage) {
      // For Gemini API, we prefix system messages to user messages
      let enhancedSystemMessage = systemMessage;
      
      // If we have tools and a chatMode, explicitly tell the model what mode it's in
      if (tools && tools.length > 0 && chatMode) {
        logger.info(`Adding chatMode (${chatMode}) context to streaming system message`);
        // Include specific tool names in the system message
        const toolNames = tools.map(t => t.name).join(', ');
        enhancedSystemMessage = `${systemMessage}\n\nIMPORTANT: You are currently in ${chatMode} mode and have access to the following tools: ${toolNames}. In agent mode, you SHOULD use all available tools including file creation and editing tools. The create_ai_comment tool allows you to create comments in the code.`;
      }
      
      requestBody.contents[0].parts[0].text = `${enhancedSystemMessage}\n\n${prompt}`;
      logger.info(`Added system message to streaming request, total prompt length: ${requestBody.contents[0].parts[0].text.length}`);
    }

    // Add tools if present
    if (tools && Array.isArray(tools) && tools.length > 0) {
      requestBody.tools = tools.map(tool => {
        // Extract required parameters (assuming all are required for now)
        const requiredParams = Object.keys(tool.parameters || {});
        
        // Format parameters to match Gemini's expected structure
        const formattedProperties: Record<string, any> = {};
        
        // Only process if parameters exist
        if (tool.parameters) {
          for (const [key, paramValue] of Object.entries(tool.parameters)) {
            // Safe type assertion as we know the structure
            const param = paramValue as { description?: string };
            
            // Determine parameter type - default to STRING if not specified
            let paramType = 'STRING';
            
            // Check if parameter description contains type hint
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
            
            // Create properly formatted parameter
            formattedProperties[key] = {
              type: paramType,
              description: param.description || ''
            };
            
            // Add items property for arrays
            if (paramType === 'ARRAY') {
              formattedProperties[key].items = { type: 'STRING' };
            }
          }
        }

        // Return properly formatted tool declaration
        return {
          functionDeclarations: [{
            name: tool.name,
            description: tool.description,
            parameters: {
              type: 'OBJECT',
              properties: formattedProperties,
              required: requiredParams
            }
          }]
        };
      });

      // Log formatted tools with more detail
      logger.info(`Added ${tools.length} tools to streaming request: ${tools.map(t => t.name).join(', ')}`);
      // Add debug logging for the first tool to verify format
      if (tools.length > 0) {
        logger.debug(`Example tool format: ${JSON.stringify(requestBody.tools[0], null, 2)}`);
      }
      
      // Add toolConfig for function calling when in agent mode
      if (chatMode === 'agent') {
        requestBody.generationConfig.functionCallingConfig = {
          // In agent mode, set to 'auto' to allow the model to decide when to use tools
          // This encourages tool usage without forcing it
          mode: 'auto'
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

    
    // Direct API call to v1beta endpoint with API key in URL
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    
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
    
    // Process the SSE stream
    // Note: accumulatedAnswer and accumulatedThoughts will be built up here.
    const reader = response.body.getReader();
    let rawResponse = null; // Store the raw response
    const decoder = new TextDecoder();
    let partialLine = ''; // Store partial line if chunk is split mid-JSON
    let partialLineTimeout: NodeJS.Timeout | null = null;
    const MAX_PARTIAL_LINE_WAIT = 5000; // Max time to wait for a partial line completion (ms)
    
    // Helper function to handle partial line timeouts
    const setupPartialLineTimeout = () => {
      // Clear any existing timeout
      if (partialLineTimeout) {
        clearTimeout(partialLineTimeout);
      }
      
      // Set new timeout
      partialLineTimeout = setTimeout(() => {
        if (partialLine) {
          logger.warn(`Partial line timed out after ${MAX_PARTIAL_LINE_WAIT}ms, discarding: ${partialLine.substring(0, 50)}...`);
          partialLine = ''; // Discard the partial line if timeout
        }
      }, MAX_PARTIAL_LINE_WAIT);
    };
    
    let chunk;
    while (!(chunk = await reader.read()).done) {
      try {
        const rawText = decoder.decode(chunk.value, { stream: true });
        
        // Log raw SSE data for debugging
        logger.debug(`Raw SSE chunk received (${rawText.length} bytes)`);
        
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
          
          if (line.startsWith('data: ')) {
            try {
              // Skip "[DONE]" message at the end
              if (line === 'data: [DONE]') {
                logger.info('Received [DONE] message from SSE stream');
                continue;
              }
              
              const jsonText = line.slice(6); // Remove "data: " prefix
              
              // Try to parse the JSON
              try {
                const data = JSON.parse(jsonText);
                
                // Log the full raw chunk data for debugging
                logger.info(`GEMINI RAW STREAM CHUNK: ${JSON.stringify(data, null, 2)}`);
                
                // Store the raw response data (will use the last chunk)
                rawResponse = data;
                
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
                  }
                  if (answerChunkForThisSSEEvent) {
                    accumulatedAnswer += answerChunkForThisSSEEvent;
                  }

                  // Call onChunk handler with combined text for now (to minimize downstream changes immediately)
                  // The final onComplete will provide the clean separation.
                  const combinedChunkText = thoughtChunkForThisSSEEvent + answerChunkForThisSSEEvent;
                  if (combinedChunkText) {
                    // Add small delay when streaming from Gemini 2.5 models
                    if (model.includes('gemini-2.5')) {
                      await new Promise(resolve => setTimeout(resolve, 5));
                    }
                    handlers.onChunk(combinedChunkText);
                  }
                }
              } catch (jsonError: any) {
                // This could be an incomplete JSON chunk
                // Store it and try to combine with the next chunk
                logger.warn(`Incomplete JSON chunk detected: ${jsonText.substring(0, 50)}...`);
                partialLine = jsonText;
                
                // Set up timeout to prevent hanging if we don't get the rest of the JSON
                setupPartialLineTimeout();
                
                // Don't break the stream for JSON parse errors
                if (jsonError.message === 'Unexpected end of JSON input') {
                  logger.warn('JSON parsing error due to incomplete chunk, will attempt to recover in next chunk');
                } else {
                  logger.error(`Error parsing JSON in SSE chunk: ${jsonError}`);
                }
              }
            } catch (error) {
              logger.error(`Error processing SSE data line: ${error}`);
              // Don't throw errors here to keep the stream going
            }
          } else if (line.startsWith('event:')) {
            // Handle SSE events according to spec (https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
            logger.info(`Received SSE event: ${line.slice(6).trim()}`);
          } else if (line.startsWith('id:')) {
            // Handle SSE event ID
            logger.info(`Received SSE ID: ${line.slice(3).trim()}`);
          } else if (line.startsWith(':')) {
            // This is a comment, typically used as a keep-alive
            logger.debug(`Received SSE comment: ${line.slice(1).trim()}`);
          } else {
            // This might be a continuation of a previous line that was split
            // Add it to partialLine if it looks like it could be part of JSON
            if (line.includes('{') || line.includes('}') || line.includes('"')) {
              partialLine += line;
              // Set up timeout when we detect a partial line
              setupPartialLineTimeout();
            }
          }
        }
      } catch (streamError) {
        // Catch any errors in the outer stream processing
        logger.error(`Error processing stream chunk: ${streamError}`);
        // Continue processing to maintain stream resilience, but don't break the flow
      }
    }
    
    // Clean up any remaining timeout
    if (partialLineTimeout) {
      clearTimeout(partialLineTimeout);
      partialLineTimeout = null;
    }
    
    // If we still have a partial line at the end, try to use it
    if (partialLine) {
      logger.warn(`Stream ended with remaining partial line: ${partialLine.substring(0, 100)}...`);
      try {
        const parsedPartial = JSON.parse(partialLine);
        rawResponse = parsedPartial;
        logger.info(`Successfully parsed final partial line as JSON: ${JSON.stringify(parsedPartial, null, 2)}`);

        if (parsedPartial.error) {
          logger.error(`Error detected in final parsed partial line: ${JSON.stringify(parsedPartial.error)}`);
          accumulatedAnswer = ''; 
          accumulatedThoughts = '';
        } else if (parsedPartial.candidates && parsedPartial.candidates[0]?.content?.parts) {
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
            logger.info(`Extracted thoughts from final parsed partial line: ${finalThoughtChunk}`);
            accumulatedThoughts += finalThoughtChunk;
          }
          if (finalAnswerChunk) {
            logger.info(`Extracted answer from final parsed partial line: ${finalAnswerChunk}`);
            // Call onChunk for the answer part, as the main loop might have missed it
            handlers.onChunk(finalAnswerChunk); 
            accumulatedAnswer += finalAnswerChunk;
          }
        }
      } catch (e) {
        logger.error(`Final partial line is not valid JSON: ${partialLine.substring(0, 100)}... Error: ${e}`);
        if (!partialLine.toLowerCase().includes("\"error\"")) {
          const textMatch = partialLine.match(/"text":\s*"([^\"]*)"/);
          if (textMatch && textMatch[1]) {
            const extractedText = textMatch[1];
            logger.info(`Extracted text via regex from non-JSON final partial line: ${extractedText}`);
            handlers.onChunk(extractedText);
            accumulatedAnswer += extractedText;
          }
        } else {
            logger.error(`Final partial line contained 'error' but was not valid JSON: ${partialLine.substring(0, 150)}`);
            let errorMessage = 'Incomplete error response from API.';
            let errorCode = 'PARTIAL_API_ERROR';
            const messageMatch = partialLine.match(/"message":\s*"([^\"]*)/);
            if (messageMatch && messageMatch[1]) errorMessage = messageMatch[1] + "...";
            const codeMatch = partialLine.match(/"code":\s*(\d+)/);
            if (codeMatch && codeMatch[1]) errorCode = `API_CODE_${codeMatch[1]}`;
            rawResponse = { error: { message: errorMessage, code: errorCode, details: partialLine } };
            accumulatedAnswer = '';
            accumulatedThoughts = '';
            logger.info('Set rawResponse to a synthesized error due to partial error JSON at stream end.');
        }
      }
    }
    
    if (model.includes('gemini-2.5')) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    if (!rawResponse && (accumulatedAnswer || accumulatedThoughts)) {
      logger.warn(`Stream completed without a valid raw response despite receiving text. Answer Length: ${accumulatedAnswer.length}, Thoughts Length: ${accumulatedThoughts.length}`);
    }
    
    const inputTokens = Math.ceil(prompt.length / 4);
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
            parameters: part.functionCall.args || {},
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

          if (responseObj.toolCall.name === 'edit_file') {
            if (!responseObj.toolCall.parameters.searchReplaceBlocks) {
              responseObj.toolCall.parameters.searchReplaceBlocks = '';
            } else if (typeof responseObj.toolCall.parameters.searchReplaceBlocks !== 'string') {
              responseObj.toolCall.parameters.searchReplaceBlocks = String(responseObj.toolCall.parameters.searchReplaceBlocks);
            }
          }
          
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
              
              responseObj.toolCall = { name: functionName, parameters: parameters, id: `extracted-${Date.now()}` };
              if (responseObj.toolCall.name === 'edit_file') { /* ... edit_file handling ... */ }
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
          parameters: rawResponse.candidates[0].functionCall.args || {},
          id: rawResponse.candidates[0].contentId || `cand-fc-${Date.now()}`
        };
        if (responseObj.toolCall.name === 'edit_file') { /* ... edit_file handling ... */ }
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
  systemMessage?: string;
  tools?: any[];
  chatMode?: 'normal' | 'gather' | 'agent';
  thinkingConfig?: ThinkingConfig;
  onStart?: () => void;
  onChunk: (chunk: string) => void;
  onError: (error: Error) => void;
  onComplete: (response: LLMResponse) => void;
}): Promise<void> {
  const { apiKey, model, prompt, temperature, maxTokens, systemMessage, tools, chatMode, thinkingConfig, onStart, onChunk, onError, onComplete } = params;
  
  // Log if tools and system message are present
  if (systemMessage) {
    logger.info(`Gemini API request includes system message, length: ${systemMessage.length}`);
  }
  
  if (tools && Array.isArray(tools) && tools.length > 0) {
    logger.info(`Gemini API request includes ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
  }
  
  
  await sendStreamingRequest(
    {
      apiKey,
      model,
      prompt,
      temperature,
      maxTokens,
      systemMessage,
      tools,
      chatMode,
      thinkingConfig
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
  systemMessage?: string;
  tools?: any[];
  chatMode?: 'normal' | 'gather' | 'agent';
  thinkingConfig?: ThinkingConfig;
}): Promise<LLMResponse> {
  const { apiKey, model, prompt, temperature, maxTokens, systemMessage, tools, chatMode, thinkingConfig } = params;
  
  // Log if tools and system message are present
  if (systemMessage) {
    logger.info(`Gemini API request includes system message, length: ${systemMessage.length}`);
  }
  
  if (tools && Array.isArray(tools) && tools.length > 0) {
    logger.info(`Gemini API request includes ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
  }
  
  return await sendRequest({
    apiKey,
    model,
    prompt,
    temperature,
    maxTokens,
    systemMessage,
    tools,
    chatMode,
    thinkingConfig
  });
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
  const { apiKey, content, model = 'text-embedding-004', apiVersion = 'v1beta' } = params;
  
  try {
    logger.info(`Generating embedding with model: ${model}, API version: ${apiVersion}`);
    
    // Use v1alpha for experimental models, v1beta for stable models
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
  const { apiKey, contents, model = 'text-embedding-004', batchSize = 5, apiVersion = 'v1beta' } = params;
  
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
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateAnswer?key=${apiKey}`;
    
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
