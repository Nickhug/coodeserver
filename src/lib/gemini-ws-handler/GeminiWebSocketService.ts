import { logger } from '../logger';
import { activeStreamManager, ToolCall, GeminiMessage } from '../streams/ActiveStreamManager';
import { sendGeminiRequest } from '../ai-providers/gemini-provider';
import { LLMResponse } from '../ai-providers/providers';
import { checkUserCreditsById } from '../clerk/auth'; // We will create this function
import { ClientEvent, ExecuteToolClientEvent, sendEventToConnection } from '../../../websocket-server/manager';

interface StreamInitiationParams {
  userId: string;
  connectionId: string;
  requestId: string;
  model: string;
  messages: GeminiMessage[];
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: { name: string; description: string; parameters: Record<string, { description: string }> }[];
}

interface ToolResultParams {
  userId: string;
  connectionId: string;
  requestId: string;
  toolCallId: string;
  output: unknown;
}

export class GeminiWebSocketService {
  constructor() {
    logger.info('[GeminiWebSocketService] Initialized');
  }

  private sendToClient(connectionId: string, event: ClientEvent) {
    sendEventToConnection(connectionId, event);
  }

  async initiateStream(params: StreamInitiationParams): Promise<void> {
    const { 
      userId, connectionId, requestId, model, messages, 
      systemMessage, temperature, maxTokens, tools 
    } = params;

    logger.info(`[GeminiWebSocketService] Initiating stream for user ${userId}, requestId ${requestId}`);

    try {
      // 1. Validate Request (Zod schemas can be used here if preferred, simplified for now)
      if (!requestId || !model || !messages) {
        throw new Error('Missing required parameters for stream initiation');
      }

      // 2. Check User Credits (using the new checkUserCreditsById)
      const textContents = messages.map((m: GeminiMessage) => m.parts.map((part: GeminiMessage['parts'][0]) => part.text || (part.inlineData ? '[IMAGE DATA]' : '')).join(' ')).join(' ');
      const estimatedTokens = Math.ceil(textContents.length / 4) * 2; // Simple estimation
      const requiredCredits = estimatedTokens / 1000; // Example calculation

      const { hasCredits, creditsRemaining } = await checkUserCreditsById(userId, requiredCredits);
      if (!hasCredits) {
        logger.warn(`[GeminiWebSocketService] Insufficient credits for user ${userId}`, { creditsRemaining, requiredCredits });
        this.sendToClient(connectionId, {
          type: 'geminiError',
          requestId,
          error: 'Insufficient credits',
          message: `You do not have enough credits. Required: ${requiredCredits}, Remaining: ${creditsRemaining}`,
        } as ClientEvent);
        return;
      }

      // 3. Register Stream with ActiveStreamManager
      activeStreamManager.register(
        requestId,
        undefined, // No controller for WebSocket-based streams
        messages,
        userId,
        { systemMessage, tools, model, temperature, maxTokens }
      );

      // 4. Send Start Event to Client
      this.sendToClient(connectionId, { type: 'geminiStart', requestId } as ClientEvent);

      // 5. Initiate Gemini Request
      sendGeminiRequest({
        apiKey: process.env.GEMINI_API_KEY!,
        model,
        messages,
        systemMessage,
        temperature,
        maxTokens,
        tools,
        onStream: (text: string, toolCallUpdate?: { name: string; parameters: Record<string, unknown>; id?: string }) => {
          if (toolCallUpdate?.id) {
            const toolCall: ToolCall = {
              name: toolCallUpdate.name,
              parameters: { ...(toolCallUpdate.parameters || {}) },
              id: toolCallUpdate.id,
            };
            activeStreamManager.trackToolCall(requestId, toolCall);
            logger.info(`[GeminiWebSocketService] Stream ${requestId}: Tool call - ${toolCall.name}`);
            this.sendToClient(connectionId, {
              type: 'executeTool',
              requestId,
              toolCall,
            } as ExecuteToolClientEvent);
          }
          if (text) {
            logger.debug(`[GeminiWebSocketService] Stream ${requestId}: Content chunk length ${text.length}`);
            this.sendToClient(connectionId, {
              type: 'geminiContent',
              requestId,
              chunk: text,
            } as ClientEvent);
          }
        },
      }).then(async (response: LLMResponse) => {
        if (!response.success && response.error) {
          logger.error(`[GeminiWebSocketService] Stream ${requestId} Error: ${response.error}`);
          this.sendToClient(connectionId, {
            type: 'geminiError',
            requestId,
            error: response.error,
            message: response.error, // Consider a more user-friendly message
          } as ClientEvent);
        } else if (response.success && !response.waitingForToolCall) {
          logger.info(`[GeminiWebSocketService] Stream ${requestId}: Done`);
          this.sendToClient(connectionId, { type: 'geminiDone', requestId } as ClientEvent);
        }

        // TODO: Log usage & update credits (ensure this is robust)

        const streamContext = activeStreamManager.get(requestId);
        if (streamContext && Object.keys(streamContext.toolCalls).length === 0 && !response.waitingForToolCall) {
          activeStreamManager.remove(requestId);
        }
      }).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[GeminiWebSocketService] Stream ${requestId} Unhandled Error: ${errorMessage}`);
        this.sendToClient(connectionId, {
          type: 'geminiError',
          requestId,
          error: 'Internal server error',
          message: errorMessage,
        } as ClientEvent);
        activeStreamManager.remove(requestId); // Clean up on unhandled error
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[GeminiWebSocketService] Error initiating stream ${requestId}: ${errorMessage}`);
      this.sendToClient(connectionId, {
        type: 'geminiError',
        requestId,
        error: 'StreamInitiationError',
        message: errorMessage,
      } as ClientEvent);
    }
  }

  async handleToolResult(params: ToolResultParams): Promise<void> {
    const { userId, connectionId, requestId, toolCallId, output } = params;
    logger.info(`[GeminiWebSocketService] Handling tool result for stream ${requestId}, toolCallId ${toolCallId}`);

    try {
      const streamContext = activeStreamManager.get(requestId);
      if (!streamContext) {
        throw new Error(`Stream with requestId ${requestId} not found.`);
      }
      if (streamContext.userId !== userId) {
        throw new Error(`User ${userId} not authorized for stream ${requestId}.`);
      }

      const { updatedMessages } = activeStreamManager.addToolResult(requestId, toolCallId, output);
      if (!updatedMessages) {
        throw new Error(`Failed to add tool result for toolCallId ${toolCallId} in stream ${requestId}.`);
      }
      
      activeStreamManager.resumeStream(requestId);

      logger.info(`[GeminiWebSocketService] Resuming stream ${requestId} with tool result.`);
      // Re-initiate Gemini request with the new message history including the tool result
      sendGeminiRequest({
        apiKey: process.env.GEMINI_API_KEY!,
        model: streamContext.model,
        messages: updatedMessages,
        systemMessage: streamContext.systemMessage,
        temperature: streamContext.temperature,
        maxTokens: streamContext.maxTokens,
        tools: streamContext.tools,
        onStream: (text: string, toolCallUpdate?: { name: string; parameters: Record<string, unknown>; id?: string }) => {
          if (toolCallUpdate?.id) {
            const toolCall: ToolCall = {
              name: toolCallUpdate.name,
              parameters: { ...(toolCallUpdate.parameters || {}) },
              id: toolCallUpdate.id,
            };
            activeStreamManager.trackToolCall(requestId, toolCall);
            logger.info(`[GeminiWebSocketService] Stream ${requestId} (resumed): Tool call - ${toolCall.name}`);
            this.sendToClient(connectionId, {
              type: 'executeTool',
              requestId,
              toolCall,
            } as ExecuteToolClientEvent);
          }
          if (text) {
            logger.debug(`[GeminiWebSocketService] Stream ${requestId} (resumed): Content chunk length ${text.length}`);
            this.sendToClient(connectionId, {
              type: 'geminiContent',
              requestId,
              chunk: text,
            } as ClientEvent);
          }
        },
      }).then(async (response: LLMResponse) => {
        if (!response.success && response.error) {
          logger.error(`[GeminiWebSocketService] Resumed Stream ${requestId} Error: ${response.error}`);
          this.sendToClient(connectionId, {
            type: 'geminiError',
            requestId,
            error: response.error,
            message: response.error,
          } as ClientEvent);
        } else if (response.success && !response.waitingForToolCall) {
          logger.info(`[GeminiWebSocketService] Resumed Stream ${requestId}: Done`);
          this.sendToClient(connectionId, { type: 'geminiDone', requestId } as ClientEvent);
        }
        // TODO: Log usage & update credits
        const currentStreamContext = activeStreamManager.get(requestId);
        if (currentStreamContext && Object.keys(currentStreamContext.toolCalls).length === 0 && !response.waitingForToolCall) {
          activeStreamManager.remove(requestId);
        }
      }).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[GeminiWebSocketService] Resumed Stream ${requestId} Unhandled Error: ${errorMessage}`);
        this.sendToClient(connectionId, {
          type: 'geminiError',
          requestId,
          error: 'Internal server error during resume',
          message: errorMessage,
        } as ClientEvent);
        activeStreamManager.remove(requestId);
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[GeminiWebSocketService] Error handling tool result for stream ${requestId}: ${errorMessage}`);
      this.sendToClient(connectionId, {
        type: 'geminiError',
        requestId,
        error: 'ToolResultProcessingError',
        message: errorMessage,
      } as ClientEvent);
    }
  }
}

// Export a singleton instance
export const geminiWebSocketService = new GeminiWebSocketService(); 