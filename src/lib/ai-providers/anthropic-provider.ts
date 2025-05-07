/**
 * Anthropic Provider Implementation
 * This file contains the implementation of the Anthropic provider API
 */

import Anthropic from '@anthropic-ai/sdk';
import { LLMResponse } from './providers';
import { generateUuid } from '../../utils/uuid';
import { logger } from '../logger';

// Define Anthropic model types
export type AnthropicModelName =
  | 'claude-3-7-sonnet-20250219'
  | 'claude-3-5-sonnet-20241022'
  | 'claude-3-5-haiku-20241022'
  | 'claude-3-opus-20240229'
  | 'claude-3-sonnet-20240229';

// Define model configuration type
export type AnthropicModelConfig = {
  contextWindow: number;
  maxOutputTokens: number;
  tokenMultiplier: number;
};

// Define the available Anthropic models
export const ANTHROPIC_MODELS: Record<AnthropicModelName, AnthropicModelConfig> = {
  'claude-3-7-sonnet-20250219': {
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    tokenMultiplier: 15.0, // 1 token = 15.0 credits for output
  },
  'claude-3-5-sonnet-20241022': {
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    tokenMultiplier: 3.0, // 1 token = 3.0 credits for output
  },
  'claude-3-5-haiku-20241022': {
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    tokenMultiplier: 0.25, // 1 token = 0.25 credits for output
  },
  'claude-3-opus-20240229': {
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    tokenMultiplier: 15.0, // 1 token = 15.0 credits for output
  },
  'claude-3-sonnet-20240229': {
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    tokenMultiplier: 3.0, // 1 token = 3.0 credits for output
  },
};

/**
 * Get model configuration for a given model name
 */
export function getModelConfig(modelName: string): AnthropicModelConfig {
  // Check if the model is in our predefined list
  if (modelName in ANTHROPIC_MODELS) {
    return ANTHROPIC_MODELS[modelName as AnthropicModelName];
  }

  // For models not in our list, use a fallback configuration
  // This handles cases where the client sends a model name we don't explicitly define
  const fallbackConfig: AnthropicModelConfig = {
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    tokenMultiplier: 3.0, // Default to a moderate cost
  };

  // Try to match the model name to a known model family
  if (modelName.includes('claude-3-7-sonnet')) {
    return ANTHROPIC_MODELS['claude-3-7-sonnet-20250219'];
  } else if (modelName.includes('claude-3-5-sonnet')) {
    return ANTHROPIC_MODELS['claude-3-5-sonnet-20241022'];
  } else if (modelName.includes('claude-3-5-haiku')) {
    return ANTHROPIC_MODELS['claude-3-5-haiku-20241022'];
  } else if (modelName.includes('claude-3-opus')) {
    return ANTHROPIC_MODELS['claude-3-opus-20240229'];
  } else if (modelName.includes('claude-3-sonnet')) {
    return ANTHROPIC_MODELS['claude-3-sonnet-20240229'];
  }

  logger.warn(`Unknown Anthropic model: ${modelName}, using fallback configuration`);
  return fallbackConfig;
}

/**
 * Estimate token count for a given text
 * This is a simple estimation - in production, you'd use a proper tokenizer
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // Rough estimate: 1 token ≈ 4 characters for English text
  return Math.ceil(text.length / 4);
}

/**
 * Convert Void tools format to Anthropic tools format
 */
export function convertToAnthropicTools(tools: { 
  name: string; 
  description: string; 
  parameters: Record<string, { description: string }> 
}[]): Anthropic.Messages.Tool[] {
  return tools.map(tool => {
    const properties: Record<string, { description: string; type: string }> = {};
    
    // Convert parameters to Anthropic format
    for (const [paramName, paramInfo] of Object.entries(tool.parameters)) {
      properties[paramName] = {
        description: paramInfo.description,
        type: 'string' // Default to string type for all parameters
      };
    }
    
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties: properties,
        required: Object.keys(properties) // Assume all parameters are required
      }
    };
  });
}

/**
 * Send a request to Anthropic with streaming support
 */
export async function sendAnthropicRequest({
  apiKey,
  model,
  messages,
  systemMessage,
  temperature = 0.7,
  maxTokens,
  tools = null,
  onStream = null,
}: {
  apiKey: string;
  model: string;
  messages: {
    role: string;
    content?: string | any;
    parts?: any[];
    displayContent?: string;
    reasoning?: string;
    anthropicReasoning?: any;
  }[];
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[] | null;
  onStream?: ((text: string) => void) | null;
}): Promise<LLMResponse> {
  try {
    // Initialize the Anthropic client
    const anthropic = new Anthropic({
      apiKey: apiKey
    });

    // Format messages for Anthropic API
    const formattedMessages = messages.map(msg => {
      // Convert role names to match Anthropic's expectations
      const role = msg.role === 'user' ? 'user' : 'assistant';
      
      // Handle content based on its type
      let content = typeof msg.content === 'string' ? msg.content : 
                    msg.displayContent ? msg.displayContent : '';
      
      return { role, content };
    });

    // Log the request details
    logger.info(`Sending Anthropic request for model ${model}`);
    if (systemMessage) {
      logger.info(`System message: ${systemMessage.substring(0, 200)}...`);
    }

    // Prepare tools if provided
    const anthropicTools = tools && tools.length > 0 ? convertToAnthropicTools(tools) : undefined;
    const toolChoice = anthropicTools ? { type: 'auto' as const } : undefined;

    // Prepare request parameters
    const requestParams: Anthropic.Messages.MessageCreateParams = {
      model: model,
      messages: formattedMessages,
      max_tokens: maxTokens || getModelConfig(model).maxOutputTokens,
      temperature: temperature,
      system: systemMessage,
    };

    // Add tools if available
    if (anthropicTools) {
      requestParams.tools = anthropicTools;
      requestParams.tool_choice = toolChoice;
    }

    // Track response data
    let fullText = '';
    let toolCall: { name: string; parameters: any; id: string } | undefined;
    let anthropicReasoning: any[] = [];

    // Handle streaming if requested
    if (onStream) {
      const stream = await anthropic.messages.stream(requestParams);

      // Process the stream
      stream.on('text', (text) => {
        fullText += text;
        onStream(text);
      });

      // Handle tool use events
      stream.on('content_block', (contentBlock) => {
        if (contentBlock.type === 'tool_use') {
          toolCall = {
            name: contentBlock.name,
            parameters: contentBlock.input,
            id: contentBlock.id
          };
          logger.info(`Tool call detected: ${contentBlock.name}`);
        } else if (contentBlock.type === 'thinking' || contentBlock.type === 'redacted_thinking') {
          anthropicReasoning.push(contentBlock);
        }
      });

      // Wait for the stream to complete
      const response = await stream.finalMessage();
      
      // Extract any thinking blocks from the response
      anthropicReasoning = response.content.filter(c => 
        c.type === 'thinking' || c.type === 'redacted_thinking'
      );
    } else {
      // Non-streaming request
      const response = await anthropic.messages.create(requestParams);
      
      // Extract text content
      fullText = response.content
        .filter(c => c.type === 'text')
        .map(c => (c as any).text)
        .join('');
      
      // Extract tool calls
      const tools = response.content.filter(c => c.type === 'tool_use');
      if (tools.length > 0) {
        const tool = tools[0] as any;
        toolCall = {
          name: tool.name,
          parameters: tool.input,
          id: tool.id
        };
      }
      
      // Extract thinking blocks
      anthropicReasoning = response.content.filter(c => 
        c.type === 'thinking' || c.type === 'redacted_thinking'
      );
    }

    // Calculate token usage and credits
    const inputTokens = estimateTokenCount(messages.map(m => {
      if (typeof m.content === 'string') {
        return m.content;
      } else if (m.displayContent) {
        return m.displayContent;
      } else if (m.content) {
        return JSON.stringify(m.content);
      }
      return '';
    }).join(' ') + (systemMessage || ''));
    
    const outputTokens = estimateTokenCount(fullText);
    const totalTokens = inputTokens + outputTokens;

    // Calculate credits used
    const modelConfig = getModelConfig(model);
    const inputCost = 3.0; // $3.00 per million tokens for input
    const outputCost = modelConfig.tokenMultiplier;
    
    const creditsUsed = (inputTokens / 1000) * (inputCost / 1000) + 
                        (outputTokens / 1000) * (outputCost / 1000);

    return {
      text: fullText,
      tokensUsed: totalTokens,
      creditsUsed: creditsUsed,
      toolCall,
      anthropicReasoning
    };
  } catch (error) {
    logger.error(`Error in Anthropic request: ${(error as Error).message}`);
    throw error;
  }
}
