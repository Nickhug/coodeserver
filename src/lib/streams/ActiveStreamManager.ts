/**
 * ActiveStreamManager
 * Tracks active HTTP streams and their associated data for WebSocket coordination
 */

import { ReadableStreamDefaultController } from 'stream/web';
import { logger } from '../logger';

// Tool call interface
export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, unknown>;
}

// Define message structure based on Gemini's format
export interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiMessage {
  role: 'user' | 'assistant' | 'system' | 'model' | 'tool';
  parts: GeminiPart[];
  content?: string | Record<string, unknown>;
  displayContent?: string;
  reasoning?: string;
  toolCallId?: string;
}

// Track data needed to continue a paused stream
export interface StreamContext {
  controller?: ReadableStreamDefaultController;
  messages: GeminiMessage[]; // Original messages sent to Gemini
  systemMessage?: string;
  tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  toolCalls: Record<string, ToolCall>; // Track active tool calls for this stream
  isPaused: boolean; // Whether we're waiting for a tool result
  userId: string; // Store user ID for auth validation
}

class ActiveStreamManager {
  private streams: Map<string, StreamContext> = new Map();

  /**
   * Register a new stream controller with its context
   */
  register(
    requestId: string,
    controller: ReadableStreamDefaultController | undefined,
    messages: GeminiMessage[],
    userId: string,
    options: {
      systemMessage?: string;
      tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[];
      model: string;
      temperature?: number;
      maxTokens?: number;
    }
  ): void {
    const { systemMessage, tools, model, temperature, maxTokens } = options;

    this.streams.set(requestId, {
      controller,
      messages,
      systemMessage,
      tools,
      model,
      temperature,
      maxTokens,
      toolCalls: {},
      isPaused: false,
      userId
    });

    logger.info(`Registered stream ${requestId} for user ${userId}`);
  }

  /**
   * Get a stream context by requestId
   */
  get(requestId: string): StreamContext | undefined {
    return this.streams.get(requestId);
  }

  /**
   * Remove a stream from tracking
   */
  remove(requestId: string): boolean {
    logger.info(`Removing stream ${requestId}`);
    return this.streams.delete(requestId);
  }

  /**
   * Track a tool call for a specific stream
   */
  trackToolCall(requestId: string, toolCall: ToolCall): boolean {
    const stream = this.streams.get(requestId);
    if (!stream) {
      logger.warn(`Cannot track tool call: Stream ${requestId} not found`);
      return false;
    }

    // Mark stream as paused while waiting for tool result
    stream.isPaused = true;
    
    // Store the tool call
    stream.toolCalls[toolCall.id] = toolCall;
    logger.info(`Tracked tool call ${toolCall.id} for stream ${requestId}`);
    
    return true;
  }

  /**
   * Mark a stream as no longer paused (ready to continue)
   */
  resumeStream(requestId: string): boolean {
    const stream = this.streams.get(requestId);
    if (!stream) {
      logger.warn(`Cannot resume stream: Stream ${requestId} not found`);
      return false;
    }

    stream.isPaused = false;
    logger.info(`Resumed stream ${requestId}`);
    return true;
  }

  /**
   * Add a tool result to the message history
   */
  addToolResult(
    requestId: string,
    toolCallId: string,
    output: unknown
  ): { success: boolean; updatedMessages?: GeminiMessage[] } {
    const stream = this.streams.get(requestId);
    if (!stream) {
      logger.warn(`Cannot add tool result: Stream ${requestId} not found`);
      return { success: false };
    }

    const toolCall = stream.toolCalls[toolCallId];
    if (!toolCall) {
      logger.warn(`Cannot add tool result: Tool call ${toolCallId} not found in stream ${requestId}`);
      return { success: false };
    }

    // Create a copy of the messages array
    const updatedMessages = [...stream.messages];

    // Add the tool result message in Gemini format
    updatedMessages.push({
      role: 'tool',
      parts: [{ text: JSON.stringify(output) }],
      toolCallId: toolCallId
    });

    // Update the messages in the stream context
    stream.messages = updatedMessages;
    logger.info(`Added tool result for tool call ${toolCallId} in stream ${requestId}`);

    return { success: true, updatedMessages };
  }

  /**
   * Validate that a user has access to a stream
   */
  validateUser(requestId: string, userId: string): boolean {
    const stream = this.streams.get(requestId);
    if (!stream) {
      return false;
    }
    return stream.userId === userId;
  }
}

// Export singleton instance
export const activeStreamManager = new ActiveStreamManager(); 