/**
 * Gemini Provider Implementation
 * This file contains the implementation of the Gemini provider API
 */

import { GoogleGenerativeAI, Content, Part, SchemaType } from '@google/generative-ai';
import { LLMResponse } from './providers';
import { generateUuid } from '@/utils/uuid';
import { logger } from '@/lib/logger';

// Export GeminiPart and GeminiMessage interfaces
export interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  // functionCall?: any; // Consider defining a proper type if used for function calls
  // functionResponse?: any; // Consider defining a proper type if used for function responses
}

export interface GeminiMessage {
  role: 'user' | 'assistant' | 'system' | 'model' | 'tool'; // 'model' is equivalent to 'assistant' for Gemini
  parts: GeminiPart[];
  content?: string | Record<string, unknown>; // For flexibility, though 'parts' is preferred by Gemini
  displayContent?: string; // Void-specific, for display
  reasoning?: string; // Void-specific
  toolCallId?: string; // For associating tool responses
}

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
  if (model in GEMINI_MODELS) {
    return GEMINI_MODELS[model as GeminiModelName];
  }
  return {
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    tokenMultiplier: 1.0,
  };
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function convertToGeminiContent(message: GeminiMessage): Content {
  const role = message.role === 'system' ? 'user' : (message.role === 'assistant' ? 'model' : message.role);
  logger.debug(`Converting message to Gemini content: ${JSON.stringify(message)}`);

  const parts: Part[] = message.parts.map(part => {
    if (part.text !== undefined) {
      return { text: part.text };
    }
    if (part.inlineData) {
      return { inlineData: { data: part.inlineData.data, mimeType: part.inlineData.mimeType } };
    }
    // Add handling for functionCall and functionResponse if defined in GeminiPart
    // if (part.functionCall) { return { functionCall: part.functionCall }; }
    // if (part.functionResponse) { return { functionResponse: part.functionResponse }; }
    return { text: '' }; // Fallback for empty/unknown part
  });

  return { role, parts };
}

export function fileToGeminiPart(file: Express.Multer.File): Part {
  const mimeType = file.mimetype;
  if (mimeType.startsWith('image/')) {
    return { inlineData: { data: file.buffer.toString('base64'), mimeType: file.mimetype } };
  }
  if (mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mimeType)) {
    return { text: file.buffer.toString('utf-8') };
  }
  return { inlineData: { data: file.buffer.toString('base64'), mimeType: file.mimetype } };
}

interface SendGeminiRequestParams {
  apiKey: string;
  model: string;
  messages: GeminiMessage[];
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
  files?: Express.Multer.File[];
  tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[] | null;
  onStream?: ((text: string, toolCallUpdate?: { name: string; parameters: Record<string, unknown>; id?: string }) => void) | null;
}

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
}: SendGeminiRequestParams): Promise<LLMResponse> {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    if (systemMessage) {
      logger.debug(`System message: ${systemMessage.substring(0, 200)}...`);
    }

    const generativeModel = genAI.getGenerativeModel({
      model: model,
      systemInstruction: systemMessage ? { role: 'user', parts: [{text: systemMessage}]} : undefined,
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: maxTokens || getModelConfig(model).maxOutputTokens,
      },
    });

    const geminiContents: Content[] = messages.map(convertToGeminiContent);

    logger.debug(`Converted Gemini contents: ${JSON.stringify(geminiContents)}`);

    if (files.length > 0) {
      for (let i = 0; i < geminiContents.length; i++) {
        if (geminiContents[i].role === 'user') {
          const originalText = geminiContents[i].parts[0]?.text || '';
          const newParts: Part[] = [{ text: originalText }];
          for (const file of files) {
            newParts.push(fileToGeminiPart(file));
          }
          geminiContents[i].parts = newParts;
          break;
        }
      }
    }

    let toolsConfig = {};
    if (tools && tools.length > 0) {
      logger.info(`Processing ${tools.length} tools for Gemini`);
      logger.debug(`Tools: ${JSON.stringify(tools.map(t => t.name))}`);
      const geminiTools = [{
        functionDeclarations: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: {
            type: SchemaType.OBJECT,
            properties: Object.entries(tool.parameters).reduce((acc, [key, value]) => {
              acc[key] = { type: SchemaType.STRING, description: value.description };
              return acc;
            }, {} as Record<string, { type: SchemaType; description: string }>),
            required: Object.keys(tool.parameters),
          }
        }))
      }];
      toolsConfig = { tools: geminiTools };
      logger.debug(`Formatted tools for Gemini: ${JSON.stringify(geminiTools[0].functionDeclarations.map(f => f.name))}`);
    }

    if (onStream) {
      let fullText = '';
      const activeToolCalls: Record<string, { name: string, parameters: Record<string, unknown>, id: string }> = {};

      const requestConfig = { contents: geminiContents, ...toolsConfig };
      logger.debug(`Sending streaming request with config: ${JSON.stringify(requestConfig)}`);

      const result = await generativeModel.generateContentStream(requestConfig);
      for await (const chunk of result.stream) {
        const newText = chunk.text() || '';
        if (newText) {
          fullText += newText;
          onStream(newText);
        }
        const functionCalls = chunk.functionCalls();
        if (functionCalls && functionCalls.length > 0) {
          for (const functionCall of functionCalls) {
            const toolName = functionCall.name || '';
            const toolParams = functionCall.args || {};
            const toolCallId = generateUuid(); 
            if (!activeToolCalls[toolCallId]) { // Use toolCallId for uniqueness
              activeToolCalls[toolCallId] = { name: toolName, parameters: toolParams as Record<string, unknown>, id: toolCallId };
              onStream('', activeToolCalls[toolCallId]);
              logger.info(`Started new tool call: ${toolName} with ID: ${toolCallId}`);
            } else {
              const existingToolCall = activeToolCalls[toolCallId];
              existingToolCall.parameters = { ...existingToolCall.parameters, ...(toolParams as Record<string, unknown>) };
              onStream('', existingToolCall);
              logger.debug(`Updated existing tool call: ${toolName} with ID: ${existingToolCall.id}`);
            }
          }
        }
      }

      const inputTokens = estimateTokenCount(messages.map(m => m.parts.map(p => p.text || '').join(' ')).join(' '));
      const outputTokens = estimateTokenCount(fullText);
      const totalTokens = inputTokens + outputTokens;
      const tokenMultiplier = getModelConfig(model).tokenMultiplier;
      const creditsUsed = (totalTokens / 1000) * tokenMultiplier;
      const lastToolCallEntry = Object.values(activeToolCalls).pop();
      const typedToolCall = lastToolCallEntry ? { name: lastToolCallEntry.name, parameters: lastToolCallEntry.parameters, id: lastToolCallEntry.id } : undefined;

      return {
        text: fullText,
        tokensUsed: totalTokens,
        creditsUsed: creditsUsed,
        toolCall: typedToolCall,
        success: true,
        generatedText: fullText,
        waitingForToolCall: !!typedToolCall,
      };
    } else {
      const requestConfig = { contents: geminiContents, ...toolsConfig };
      logger.debug(`Sending non-streaming request with config: ${JSON.stringify(requestConfig)}`);
      const result = await generativeModel.generateContent(requestConfig);
      const response = result.response;
      const text = response.text();
      let toolCall;
      const functionCalls = response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        const functionCall = functionCalls[0];
        toolCall = { name: functionCall.name, parameters: functionCall.args as Record<string, unknown>, id: generateUuid() };
        logger.info(`Function call detected in non-streaming response: ${functionCall.name} with params: ${JSON.stringify(functionCall.args)}`);
      }
      const inputTokens = estimateTokenCount(messages.map(m => m.parts.map(p => p.text || '').join(' ')).join(' '));
      const outputTokens = estimateTokenCount(text);
      const totalTokens = inputTokens + outputTokens;
      const tokenMultiplier = getModelConfig(model).tokenMultiplier;
      const creditsUsed = (totalTokens / 1000) * tokenMultiplier;
      return {
        text,
        tokensUsed: totalTokens,
        creditsUsed: creditsUsed,
        toolCall,
        success: true,
        generatedText: text,
        waitingForToolCall: !!toolCall,
      };
    }
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
