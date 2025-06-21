import OpenAI from 'openai';
import { ChatMessage, ToolCall } from '@repo/types';
import { LLMResponse } from '@repo/ai-providers';
import { Readable } from 'stream';

const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';

interface OpenRouterChatParams {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: any[];
  toolChoice?: 'auto' | 'none' | 'required';
  systemMessage?: string;
  onStream?: (chunk: string, functionCalls?: any[]) => void;
  onComplete: (response: LLMResponse) => void;
  onError: (error: Error) => void;
  siteUrl?: string;
  appName?: string;
}

function getOpenAIClient(apiKey: string, siteUrl?: string, appName?: string): OpenAI {
  const defaultHeaders: Record<string, string> = {};
  if (siteUrl) {
    defaultHeaders['HTTP-Referer'] = siteUrl;
  }
  if (appName) {
    defaultHeaders['X-Title'] = appName;
  }

  return new OpenAI({
    baseURL: OPENROUTER_API_BASE_URL,
    apiKey: apiKey,
    defaultHeaders,
  });
}

export async function listModels(apiKey: string): Promise<any[]> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`Failed to fetch models from OpenRouter: ${response.statusText}`);
    }
    const data = await response.json();
    return data.data; // The models are in the 'data' property
  } catch (error) {
    console.error('Error fetching OpenRouter models:', error);
    return [];
  }
}

export async function processChat({
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  stream = true,
  tools,
  toolChoice,
  systemMessage,
  onStream,
  onComplete,
  onError,
  siteUrl,
  appName,
}: OpenRouterChatParams): Promise<void> {
  try {
    const openai = getOpenAIClient(apiKey, siteUrl, appName);

    // Prepare messages following OpenAI conversation standards
    const formattedMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    // Add system message as developer role if provided (following OpenAI standards)
    if (systemMessage) {
      formattedMessages.push({
        role: 'developer',
        content: systemMessage
      });
    }

    // Add conversation messages, ensuring proper role mapping
    for (const message of messages) {
      if (message.role === 'tool') {
        formattedMessages.push({
          role: 'tool',
          content: message.content as string,
          tool_call_id: (message as any).tool_call_id
        });
      } else if (message.role === 'system') {
        // Skip system role messages as we already added the system message as developer role
        // This prevents duplicate system instructions
        continue;
      } else {
        formattedMessages.push({
          role: message.role as 'user' | 'assistant',
          content: message.content
        });
      }
    }

    const completionParams: OpenAI.Chat.ChatCompletionCreateParams = {
      model,
      messages: formattedMessages,
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens,
      stream,
      tools,
      tool_choice: toolChoice,
    };

    if (stream) {
      const streamResponse = await openai.chat.completions.create({
        ...completionParams,
        stream: true,
      });

      let fullText = '';
      const toolCalls: ToolCall[] = [];
      const toolCallDeltas: { [index: number]: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall } = {};

      for await (const chunk of streamResponse) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          fullText += delta.content;
          onStream?.(delta.content, undefined);
        }

        if (delta?.tool_calls) {
            delta.tool_calls.forEach((toolCallDelta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall) => {
                if (toolCallDelta.index !== undefined) {
                    if (!toolCallDeltas[toolCallDelta.index]) {
                        toolCallDeltas[toolCallDelta.index] = { ...toolCallDelta };
                    } else {
                        const current = toolCallDeltas[toolCallDelta.index];
                        if (toolCallDelta.id) current.id = toolCallDelta.id;
                        if (toolCallDelta.type) current.type = toolCallDelta.type;
                        if (toolCallDelta.function?.name) {
                            if (!current.function) current.function = { name: '', arguments: '' };
                            current.function.name = toolCallDelta.function.name;
                        }
                        if (toolCallDelta.function?.arguments) {
                            if (!current.function) current.function = { name: '', arguments: '' };
                            current.function.arguments += toolCallDelta.function.arguments;
                        }
                    }
                }
            });
        }
      }

      const finalToolCalls = Object.values(toolCallDeltas).map(delta => ({
        id: delta.id ?? '',
        type: 'function' as const,
        function: {
            name: delta.function?.name ?? '',
            arguments: delta.function?.arguments ?? ''
        }
      }));

      if(finalToolCalls.length > 0) {
        onStream?.('', finalToolCalls);
      }

      onComplete({
        text: fullText,
        tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
      });

    } else {
      const completion = await openai.chat.completions.create(completionParams as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
      const choice = completion.choices[0];
      onComplete({
        text: choice.message.content ?? '',
        tool_calls: choice.message.tool_calls?.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
        finish_reason: choice.finish_reason,
        usage: {
          promptTokens: completion.usage?.prompt_tokens ?? 0,
          completionTokens: completion.usage?.completion_tokens ?? 0,
          totalTokens: completion.usage?.total_tokens ?? 0,
        },
      });
    }
  } catch (error) {
    if (error instanceof Error) {
      onError(error);
    } else {
      onError(new Error('An unknown error occurred with OpenRouter.'));
    }
  }
} 