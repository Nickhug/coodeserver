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
  chatMode?: 'normal' | 'gather' | 'agent';
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
  systemMessage?: string;
  tools?: any[];
  chatMode?: 'normal' | 'gather' | 'agent';
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
  // Declare completeText at the function scope so it's available in the catch block
  let completeText = '';
  
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
        enhancedSystemMessage = `${systemMessage}\n\nIMPORTANT: You are currently in ${chatMode} mode and have access to the tools provided. In agent mode, you SHOULD use all available tools including file creation and editing tools.`;
      }
      
      requestBody.contents[0].parts[0].text = `${enhancedSystemMessage}\n\n${prompt}`;
      logger.info(`Added system message to streaming request, total prompt length: ${requestBody.contents[0].parts[0].text.length}`);
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
      
      logger.info(`Added ${tools.length} tools to streaming request: ${tools.map(t => t.name).join(', ')}`);
      
      // If we have a chatMode, log it
      if (chatMode) {
        logger.info(`Streaming request includes chatMode: ${chatMode}`);
      }
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
                
                // Extract text content
                let chunkText = '';
                if (data.candidates && 
                    data.candidates[0]?.content?.parts && 
                    data.candidates[0].content.parts.length > 0) {
                  
                  // Extract text content only
                  for (const part of data.candidates[0].content.parts) {
                    if (part.text) {
                      chunkText += part.text;
                    }
                  }
                  
                  // Call onChunk handler with small delay
                  if (chunkText) {
                    // Add small delay when streaming from Gemini 2.5 models
                    if (model.includes('gemini-2.5')) {
                      await new Promise(resolve => setTimeout(resolve, 5));
                    }
                    
                    handlers.onChunk(chunkText);
                    completeText += chunkText;
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
        // If parsing succeeded, this partial line was actually a complete JSON object.
        // It could be a final data chunk or an error object.
        rawResponse = parsedPartial; // Update rawResponse with this final parsed object
        logger.info(`Successfully parsed final partial line as JSON: ${JSON.stringify(parsedPartial, null, 2)}`);

        // Check if this parsed final object is an error
        if (parsedPartial.error) {
          logger.error(`Error detected in final parsed partial line: ${JSON.stringify(parsedPartial.error)}`);
          // This error will be handled by onComplete based on rawResponse
          completeText = ''; // Clear any previously accumulated text if we end on an error
        } else if (parsedPartial.candidates && parsedPartial.candidates[0]?.content?.parts) {
          // Or, if it's a regular data chunk, extract text
          let finalChunkText = '';
          for (const part of parsedPartial.candidates[0].content.parts) {
            if (part.text) {
              finalChunkText += part.text;
            }
          }
          if (finalChunkText) {
            logger.info(`Extracted text from final parsed partial line: ${finalChunkText}`);
            handlers.onChunk(finalChunkText); // Process it like a regular chunk
            completeText += finalChunkText;
          }
        }
      } catch (e) {
        // JSON.parse failed, so it's not a complete JSON object.
        // This is the case for the originally reported log.
        logger.error(`Final partial line is not valid JSON: ${partialLine.substring(0, 100)}... Error: ${e}`);
        // Attempt to extract text using regex as a last resort, if it wasn't an error that should have been JSON
        if (!partialLine.toLowerCase().includes('"error"')) {
          const textMatch = partialLine.match(/"text":\s*"([^"]*)"/);
          if (textMatch && textMatch[1]) {
            const extractedText = textMatch[1];
            logger.info(`Extracted text via regex from non-JSON final partial line: ${extractedText}`);
            handlers.onChunk(extractedText);
            completeText += extractedText;
          }
        } else {
            // It contains "error" but isn't valid JSON. This is the problematic scenario.
            logger.error(`Final partial line contained 'error' but was not valid JSON: ${partialLine.substring(0, 150)}`);
            // Synthesize an error in rawResponse so onComplete can handle it.
            let errorMessage = 'Incomplete error response from API.';
            let errorCode = 'PARTIAL_API_ERROR';
            // Try to extract a message from the partial error if possible
            const messageMatch = partialLine.match(/"message":\s*"([^"]*)/);
            if (messageMatch && messageMatch[1]) {
                errorMessage = messageMatch[1] + "..."; // Indicate it's partial
            }
            const codeMatch = partialLine.match(/"code":\s*(\d+)/);
            if (codeMatch && codeMatch[1]) {
                errorCode = `API_CODE_${codeMatch[1]}`;
            }
            rawResponse = { error: { message: errorMessage, code: errorCode, details: partialLine } };
            completeText = ''; // Clear any text, we are ending on an error.
            logger.info('Set rawResponse to a synthesized error due to partial error JSON at stream end.');
        }
      }
    }
    
    // Ensure we wait a moment before sending the completion to avoid race conditions
    if (model.includes('gemini-2.5')) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Remove the synthetic response generation and just log if no response was received
    if (!rawResponse && completeText) {
      // Instead of creating a synthetic response, just log the issue
      logger.warn(`Stream completed without a valid raw response despite receiving text content. Length: ${completeText.length} chars`);
      // We will continue with whatever partial responses we received
    }
    
    // Estimate token usage
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(completeText.length / 4);
    const totalTokens = inputTokens + outputTokens;
    
    logger.info(`Gemini stream completed, estimated tokens: ${totalTokens}`);
    
    // Pass the raw response to the completion handler
    // The client side will handle parsing tool calls
    const responseObj: {
      text: string;
      tokensUsed: number;
      creditsUsed: number;
      success: boolean;
      generatedText: string;
      rawResponse: any;
      toolCall?: {
        name: string;
        parameters: Record<string, unknown>;
        id: string;
      };
      waitingForToolCall?: boolean;
    } = {
      text: completeText,
      tokensUsed: totalTokens,
      creditsUsed: totalTokens / 1000, // Assuming 1000 tokens = 1 credit
      success: true,
      generatedText: completeText,
      rawResponse: rawResponse // Include the raw response as received, without modification
    };

    // Check for toolCall but don't transform it
    if (rawResponse && 
        rawResponse.candidates && 
        rawResponse.candidates[0]?.content?.parts) {
      
      // Log the entire response structure for debugging
      logger.info(`RAW RESPONSE STRUCTURE: ${JSON.stringify({
        hasContent: !!rawResponse.candidates[0].content,
        contentParts: rawResponse.candidates[0].content?.parts?.length,
        hasToolCall: rawResponse.candidates[0].content?.parts?.some((p: any) => p.functionCall)
      }, null, 2)}`);
      
      // Check each part for a function call
      for (const part of rawResponse.candidates[0].content.parts) {
        if (part.functionCall) {
          logger.info(`Found functionCall in part: ${JSON.stringify(part.functionCall, null, 2)}`);
          
          responseObj.toolCall = {
            name: part.functionCall.name,
            parameters: part.functionCall.args || {},
            id: rawResponse.candidates[0].contentId || 'unknown'
          };
          
          // Special handling for edit_file tool
          if (responseObj.toolCall.name === 'edit_file') {
            // Ensure that searchReplaceBlocks parameter exists and is a string
            if (!responseObj.toolCall.parameters.searchReplaceBlocks) {
              logger.warn(`Edit file tool call missing searchReplaceBlocks parameter, adding empty default`);
              responseObj.toolCall.parameters.searchReplaceBlocks = '';
            } else if (typeof responseObj.toolCall.parameters.searchReplaceBlocks !== 'string') {
              logger.warn(`Edit file tool call has non-string searchReplaceBlocks, converting to string`);
              responseObj.toolCall.parameters.searchReplaceBlocks = String(responseObj.toolCall.parameters.searchReplaceBlocks);
            }
          }
          
          // Explicitly ensure waitingForToolCall is true
          responseObj.waitingForToolCall = true;
          
          logger.info(`Set toolCall in response: ${JSON.stringify(responseObj.toolCall, null, 2)}`);
          logger.info(`waitingForToolCall set to: ${responseObj.waitingForToolCall}`);
          break;
        }
      }
      
      // Also check for any potential function call patterns in the text itself
      // This is a fallback mechanism for when the model includes function call syntax in text
      if (!responseObj.toolCall && completeText) {
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
          const match = completeText.match(pattern);
          if (match) {
            logger.info(`Found function call pattern in text: ${match[1]}`);
            
            // Don't send the function call as text to the client
            // Extract it as a toolCall instead
            try {
              // Attempt to extract the function name
              const functionName = match[1];
              let parameters = {};
              
              // Try to extract parameters as well
              const paramMatch = completeText.match(/"parameters":\s*(\{[\s\S]*?\})/);
              if (paramMatch) {
                try {
                  parameters = JSON.parse(paramMatch[1]);
                } catch (e) {
                  logger.error(`Failed to parse parameters from text: ${e}`);
                }
              }
              
              responseObj.toolCall = {
                name: functionName,
                parameters: parameters,
                id: `extracted-${Date.now()}`
              };
              
              // Special handling for edit_file tool
              if (responseObj.toolCall.name === 'edit_file') {
                // Ensure that searchReplaceBlocks parameter exists and is a string
                if (!responseObj.toolCall.parameters.searchReplaceBlocks) {
                  logger.warn(`Extracted edit_file tool call missing searchReplaceBlocks parameter, adding empty default`);
                  responseObj.toolCall.parameters.searchReplaceBlocks = '';
                } else if (typeof responseObj.toolCall.parameters.searchReplaceBlocks !== 'string') {
                  logger.warn(`Extracted edit_file tool call has non-string searchReplaceBlocks, converting to string`);
                  responseObj.toolCall.parameters.searchReplaceBlocks = String(responseObj.toolCall.parameters.searchReplaceBlocks);
                }
              }
              
              responseObj.waitingForToolCall = true;
              
              logger.info(`Extracted toolCall from text: ${JSON.stringify(responseObj.toolCall, null, 2)}`);
              
              // Remove the function call text from the response
              responseObj.text = completeText.replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/, '');
              
              break;
            } catch (e) {
              logger.error(`Failed to extract function call from text: ${e}`);
            }
          }
        }
      }
      
      // Check candidate-level function call
      if (!responseObj.toolCall && rawResponse.candidates[0].functionCall) {
        logger.info(`Found candidate-level functionCall: ${JSON.stringify(rawResponse.candidates[0].functionCall, null, 2)}`);
        
        responseObj.toolCall = {
          name: rawResponse.candidates[0].functionCall.name,
          parameters: rawResponse.candidates[0].functionCall.args || {},
          id: rawResponse.candidates[0].contentId || 'unknown'
        };
        
        // Special handling for edit_file tool
        if (responseObj.toolCall.name === 'edit_file') {
          // Ensure that searchReplaceBlocks parameter exists and is a string
          if (!responseObj.toolCall.parameters.searchReplaceBlocks) {
            logger.warn(`Candidate-level edit_file tool call missing searchReplaceBlocks parameter, adding empty default`);
            responseObj.toolCall.parameters.searchReplaceBlocks = '';
          } else if (typeof responseObj.toolCall.parameters.searchReplaceBlocks !== 'string') {
            logger.warn(`Candidate-level edit_file tool call has non-string searchReplaceBlocks, converting to string`);
            responseObj.toolCall.parameters.searchReplaceBlocks = String(responseObj.toolCall.parameters.searchReplaceBlocks);
          }
        }
        
        // Explicitly ensure waitingForToolCall is true
        responseObj.waitingForToolCall = true;
        
        logger.info(`Set candidate-level toolCall in response: ${JSON.stringify(responseObj.toolCall, null, 2)}`);
        logger.info(`waitingForToolCall set to: ${responseObj.waitingForToolCall}`);
      }
    }

    // Log the final response object
    logger.info(`FINAL RESPONSE OBJECT: ${JSON.stringify({
      hasToolCall: !!responseObj.toolCall,
      isWaitingForToolCall: responseObj.waitingForToolCall,
      toolCallName: responseObj.toolCall?.name
    }, null, 2)}`);

    // Call onComplete handler
    handlers.onComplete(responseObj as LLMResponse);
  } catch (error) {
    logger.error(`Error in Gemini stream: ${error instanceof Error ? error.message : String(error)}`);
    
    // Even when there's an error in the stream overall, we may have received some content
    // If we have any content, we should still deliver it to the client
    if (completeText) {
      logger.info(`Despite stream error, returning collected text of length ${completeText.length}`);
      // Create a minimal response with the text we did receive
      const errorResponse: LLMResponse = {
        text: completeText,
        tokensUsed: Math.ceil(completeText.length / 4), // Rough estimate
        success: false, // Mark as not fully successful
        error: error instanceof Error ? error.message : String(error),
        generatedText: completeText
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
  onStart?: () => void;
  onChunk: (chunk: string) => void;
  onError: (error: Error) => void;
  onComplete: (response: LLMResponse) => void;
}): Promise<void> {
  const { apiKey, model, prompt, temperature, maxTokens, systemMessage, tools, chatMode, onStart, onChunk, onError, onComplete } = params;
  
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
      chatMode
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
}): Promise<LLMResponse> {
  const { apiKey, model, prompt, temperature, maxTokens, systemMessage, tools, chatMode } = params;
  
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
    chatMode
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
