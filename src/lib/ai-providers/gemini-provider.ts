/**
 * Gemini Provider Implementation
 * This file contains the implementation of the Gemini provider API
 */

import { GoogleGenerativeAI, Tool, SchemaType, Content, Part } from '@google/generative-ai';
import { LLMResponse } from './providers';
import { generateUuid } from '../../utils/uuid';
import { logger } from '../logger';

// Define Gemini model types
export type GeminiModelName =
  | 'gemini-1.5-flash'
  | 'gemini-1.5-pro'
  | 'gemini-1.5-flash-8b'
  | 'gemini-2.5-flash-preview-04-17'
  | 'gemini-2.5-pro-exp-03-25';

// Define model configuration type
export type GeminiModelConfig = {
  contextWindow: number;
  maxOutputTokens: number;
  tokenMultiplier: number;
};

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
};

// Helper function to get model config with fallback for unknown models
function getModelConfig(model: string): GeminiModelConfig {
  // Check if the model is in our predefined list
  if (model in GEMINI_MODELS) {
    return GEMINI_MODELS[model as GeminiModelName];
  }

  // Default config for unknown models
  return {
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    tokenMultiplier: 1.0,
  };
}

// Estimate token count (very rough estimate)
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Convert a chat message to Gemini format
 * Handles both standard format and Void's format with parts array
 */
function convertToGeminiMessage(message: any): Content {
  // Determine the role (convert 'system' to 'user' as Gemini doesn't support system role)
  const role = message.role === 'system' ? 'user' : message.role;

  // Log the message for debugging
  logger.info(`Converting message to Gemini format: ${JSON.stringify(message)}`);

  // Handle Void's format with parts array
  if (message.parts && Array.isArray(message.parts)) {
    // If message already has parts array in Void format, convert it to Gemini format
    return {
      role: role,
      parts: message.parts.map((part: any) => {
        // If part has text property, use it directly
        if (part.text !== undefined) {
          return { text: part.text };
        }
        // If part has data property (for images, etc.), use it directly
        if (part.data !== undefined) {
          return {
            inlineData: {
              data: part.data,
              mimeType: part.mimeType || 'text/plain'
            }
          };
        }
        // Otherwise, convert to string
        return { text: JSON.stringify(part) };
      })
    };
  }

  // Handle displayContent field from Void
  if (message.displayContent) {
    return {
      role: role,
      parts: [{ text: message.displayContent }],
    };
  }

  // Handle standard format with content field
  if (typeof message.content === 'string') {
    return {
      role: role,
      parts: [{ text: message.content }],
    };
  }

  // Handle case where content is an object or array
  if (message.content) {
    return {
      role: role,
      parts: [{ text: JSON.stringify(message.content) }],
    };
  }

  // Fallback for empty messages
  return {
    role: role,
    parts: [{ text: "" }],
  };
}

/**
 * Convert a file to a Gemini Part
 */
export function fileToGeminiPart(file: Express.Multer.File): Part {
  const mimeType = file.mimetype;

  // For images
  if (mimeType.startsWith('image/')) {
    return {
      inlineData: {
        data: file.buffer.toString('base64'),
        mimeType: file.mimetype
      }
    };
  }

  // For text files, convert to text
  if (mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/xml' ||
      mimeType === 'application/javascript') {
    return {
      text: file.buffer.toString('utf-8')
    };
  }

  // Default to binary data
  return {
    inlineData: {
      data: file.buffer.toString('base64'),
      mimeType: file.mimetype
    }
  };
}

/**
 * Send a request to Gemini with streaming support
 */
export async function sendGeminiRequest({
  apiKey,
  model,
  messages,
  systemMessage,
  temperature = 0.7,
  maxTokens,
  files = [],
  tools = null,
  onStream = null,
}: {
  apiKey: string;
  model: string; // Can be any Gemini model, including ones not in our predefined list
  messages: { role: string; content: string }[];
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
  files?: Express.Multer.File[];
  tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[] | null;
  onStream?: ((text: string) => void) | null;
}): Promise<LLMResponse> {
  try {
    // Initialize the Gemini API
    const genAI = new GoogleGenerativeAI(apiKey);

    // Get the generative model
    const generativeModel = genAI.getGenerativeModel({
      model: model,
      systemInstruction: systemMessage,
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: maxTokens || getModelConfig(model).maxOutputTokens,
      },
    });

    // Convert messages to Gemini format
    const geminiMessages: Content[] = messages.map(convertToGeminiMessage);

    // Log the converted messages for debugging
    logger.info(`Converted Gemini messages: ${JSON.stringify(geminiMessages)}`);

    // Validate that the messages are in the correct format
    for (const message of geminiMessages) {
      if (!message.parts || !Array.isArray(message.parts) || message.parts.length === 0) {
        throw new Error(`Invalid message format: Each message must have a non-empty parts array`);
      }

      for (const part of message.parts) {
        if (part.text === undefined && part.inlineData === undefined) {
          throw new Error(`Invalid part format: Each part must have either text or inlineData`);
        }
      }
    }

    // Handle files if present
    if (files.length > 0) {
      // For the first user message, add files as parts
      for (let i = 0; i < geminiMessages.length; i++) {
        if (geminiMessages[i].role === 'user') {
          // Get the original text
          const originalText = geminiMessages[i].parts[0].text || '';

          // Create a new array of parts with the text first
          const newParts: Part[] = [{ text: originalText }];

          // Add file parts - convert them to the right format
          for (const file of files) {
            const filePart = fileToGeminiPart(file);
            // Explicitly cast to any to bypass type checking
            // This is safe because we know the structure is compatible
            newParts.push(filePart as any);
          }

          // Replace the parts array
          geminiMessages[i].parts = newParts;
          break; // Only add to the first user message
        }
      }
    }

    // Handle tools if present
    let toolsConfig = {};
    if (tools && tools.length > 0) {
      // Convert tools to the format expected by Gemini
      // We're using any here to bypass TypeScript's strict checking
      // This is necessary because the Gemini API has complex types
      const geminiTools: any[] = [{
        functionDeclarations: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: {
            type: SchemaType.OBJECT,
            properties: Object.entries(tool.parameters).reduce((acc: any, [key, value]) => {
              acc[key] = {
                type: SchemaType.STRING,
                description: value.description
              };
              return acc;
            }, {})
          }
        }))
      }];

      toolsConfig = { tools: geminiTools };
    }

    // If streaming is requested
    if (onStream) {
      let fullText = '';
      let toolName = '';
      let toolParamsStr = '';

      const result = await generativeModel.generateContentStream({
        contents: geminiMessages,
        ...toolsConfig,
      });

      // Process the stream
      for await (const chunk of result.stream) {
        const newText = chunk.text() || '';
        fullText += newText;

        // Check for function calls
        const functionCalls = chunk.functionCalls();
        if (functionCalls && functionCalls.length > 0) {
          const functionCall = functionCalls[0];
          toolName = functionCall.name || '';
          toolParamsStr = JSON.stringify(functionCall.args || {});
        }

        // Call the stream callback
        onStream(newText);
      }

      // Calculate token usage
      const inputTokens = estimateTokenCount(messages.map(m => m.content).join(' '));
      const outputTokens = estimateTokenCount(fullText);
      const totalTokens = inputTokens + outputTokens;

      // Calculate credits used
      const tokenMultiplier = getModelConfig(model).tokenMultiplier;
      const creditsUsed = (totalTokens / 1000) * tokenMultiplier;

      return {
        text: fullText,
        tokensUsed: totalTokens,
        creditsUsed: creditsUsed,
        toolCall: toolName ? {
          name: toolName,
          parameters: JSON.parse(toolParamsStr),
          id: generateUuid()
        } : undefined
      };
    }
    // Non-streaming request
    else {
      const result = await generativeModel.generateContent({
        contents: geminiMessages,
        ...toolsConfig,
      });

      const response = result.response;
      const text = response.text();

      // Check for function calls
      let toolCall;
      const functionCalls = response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        const functionCall = functionCalls[0];
        toolCall = {
          name: functionCall.name,
          parameters: functionCall.args,
          id: generateUuid()
        };
      }

      // Calculate token usage
      const inputTokens = estimateTokenCount(messages.map(m => m.content).join(' '));
      const outputTokens = estimateTokenCount(text);
      const totalTokens = inputTokens + outputTokens;

      // Calculate credits used
      const tokenMultiplier = getModelConfig(model).tokenMultiplier;
      const creditsUsed = (totalTokens / 1000) * tokenMultiplier;

      return {
        text,
        tokensUsed: totalTokens,
        creditsUsed: creditsUsed,
        toolCall
      };
    }
  } catch (error) {
    logger.error('Error in Gemini request:', error);
    throw error;
  }
}
