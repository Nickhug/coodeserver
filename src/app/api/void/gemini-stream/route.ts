import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUserWithDb } from '../../../../lib/clerk/auth';
import { checkUserCredits } from '../../../../lib/clerk/auth';
// import { updateUserCredits } from '../../../../lib/supabase/client'; // Commented out
import { sendGeminiRequest, GeminiMessage, GeminiPart } from '../../../../lib/ai-providers/gemini-provider';
// import { logUsage } from '../../../../lib/supabase/client'; // Commented out
import { logger } from '../../../../lib/logger';
import { createCorsResponse } from '../../../../lib/api-utils';
import { activeStreamManager, ToolCall } from '../../../../lib/streams/ActiveStreamManager';
import { sendEventToClient, ClientEvent, ExecuteToolClientEvent } from '../../../../../websocket-server/manager';

// Zod schema for GeminiPart for validation, aligning with GeminiPart interface
const geminiPartSchema: z.ZodType<GeminiPart> = z.object({
  text: z.string().optional(),
  inlineData: z.object({
    mimeType: z.string(),
    data: z.string(),
  }).optional(),
  // functionCall and functionResponse are omitted as they are not typically sent by clients
}).refine(data => data.text !== undefined || data.inlineData !== undefined, {
  message: "Each part must have either 'text' or 'inlineData'",
});

// Zod schema for GeminiMessage for validation, aligning with GeminiMessage interface
const geminiMessageSchema: z.ZodType<GeminiMessage> = z.object({
  role: z.enum(['user', 'assistant', 'system', 'model', 'tool']),
  parts: z.array(geminiPartSchema),
  content: z.string().or(z.record(z.unknown())).optional(), // Align with GeminiMessage content type
  displayContent: z.string().optional(),
  reasoning: z.string().optional(),
  toolCallId: z.string().optional(),
});

const requestSchema = z.object({
  model: z.string(),
  messages: z.array(geminiMessageSchema),
  systemMessage: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  requestId: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.record(z.object({ description: z.string() })),
    })
  ).optional(),
  providerName: z.string().optional(),
  isServerRequest: z.boolean().optional(),
});

/**
 * Handle OPTIONS requests for CORS preflight
 */
export async function OPTIONS() {
  return createCorsResponse({}, 200);
}

/**
 * Streaming API endpoint for Gemini - Initiates stream, content flows via WebSocket
 */
export async function GET(req: NextRequest) {
  try {
    logger.info('Gemini stream initiation request received (GET)');
    const userInfo = await getCurrentUserWithDb(req);
    if (!userInfo?.dbUser?.id) {
      logger.warn('Unauthorized access attempt to Gemini stream initiation');
      return NextResponse.json({ event: 'error', error: 'Unauthorized', message: 'Authentication failed.' }, { status: 401 });
    }
    const userId = userInfo.dbUser.id;

    const url = new URL(req.url);
    const messagesFromQuery = JSON.parse(url.searchParams.get('messages') || '[]');

    const reqData = {
      model: url.searchParams.get('model') || 'gemini-1.5-pro',
      requestId: url.searchParams.get('requestId') || Math.random().toString(36).substring(2, 15),
      messages: messagesFromQuery as GeminiMessage[], // Assert type for Zod, will be validated
      systemMessage: url.searchParams.get('systemMessage') || undefined,
      temperature: url.searchParams.get('temperature') ? parseFloat(url.searchParams.get('temperature')!) : undefined,
      maxTokens: url.searchParams.get('maxTokens') ? parseInt(url.searchParams.get('maxTokens')!, 10) : undefined,
      tools: url.searchParams.get('tools') ? JSON.parse(url.searchParams.get('tools')!) : undefined,
    };

    const validationResult = requestSchema.safeParse(reqData);
    if (!validationResult.success) {
      logger.warn('Invalid request to Gemini stream initiation', { details: validationResult.error.format() });
      const errorEvent: ClientEvent = { type: 'geminiError', requestId: reqData.requestId, error: 'Invalid request', message: JSON.stringify(validationResult.error.format()) };
      sendEventToClient(userId, errorEvent);
      return NextResponse.json({ error: 'Invalid request', details: validationResult.error.format() }, { status: 400 });
    }

    const { model, messages, systemMessage, temperature, maxTokens, requestId, tools } = validationResult.data;

    const textContents = messages.map(m => m.parts.map(part => part.text || (part.inlineData ? '[IMAGE DATA]' : '')).join(' ')).join(' ');
    const estimatedTokens = Math.ceil(textContents.length / 4) * 2;
    const requiredCredits = estimatedTokens / 1000;

    const { hasCredits, creditsRemaining } = await checkUserCredits(requiredCredits, req);
    if (!hasCredits) {
      logger.warn(`Insufficient credits for user ${userId}`, { creditsRemaining, requiredCredits });
      const errorEvent: ClientEvent = { type: 'geminiError', requestId, error: 'Insufficient credits', creditsRemaining, requiredCredits };
      sendEventToClient(userId, errorEvent);
      return NextResponse.json({ error: 'Insufficient credits', creditsRemaining, requiredCredits, requestId }, { status: 402 });
    }

    logger.info(`Processing Gemini stream initiation for user ${userId}`, { model, requestId });

    activeStreamManager.register(
      requestId,
      undefined, // Controller is now optional and not used for WebSocket streaming
      messages, 
      userId,
      { systemMessage, tools, model, temperature, maxTokens }
    );
    
    const startEvent: ClientEvent = { type: 'geminiStart', requestId };
    sendEventToClient(userId, startEvent);

    sendGeminiRequest({
      apiKey: process.env.GEMINI_API_KEY!,
      model,
      messages,
      systemMessage,
      temperature,
      maxTokens,
      tools,
      onStream: (text, toolCallUpdate) => {
        if (toolCallUpdate?.id) {
          const toolCall: ToolCall = { name: toolCallUpdate.name, parameters: { ...(toolCallUpdate.parameters || {}) },  id: toolCallUpdate.id };
          activeStreamManager.trackToolCall(requestId, toolCall);
          logger.info(`Gemini stream: Tool call for ${requestId} - ${toolCall.name}`);
          // Construct the correct event for executeTool
          const toolEvent: ExecuteToolClientEvent = { type: 'executeTool', requestId, toolCall };
          sendEventToClient(userId, toolEvent);
        }
        if (text) {
          logger.debug(`Gemini stream: Content for ${requestId} - chunk length ${text.length}`);
          const contentEvent: ClientEvent = { type: 'geminiContent', requestId, chunk: text };
          sendEventToClient(userId, contentEvent);
        }
      }
    }).then(async response => {
      if (!response.success && response.error) {
        logger.error(`Gemini stream: Error for ${requestId} - ${response.error}`);
        const errorEvent: ClientEvent = { type: 'geminiError', requestId, error: response.error };
        sendEventToClient(userId, errorEvent);
      } else if (response.success && !response.waitingForToolCall) {
        logger.info(`Gemini stream: Done for ${requestId}`);
        const doneEvent: ClientEvent = { type: 'geminiDone', requestId };
        sendEventToClient(userId, doneEvent);
      }

      // await logUsage({
      //   user_id: userId,
      //   provider: 'google',
      //   model: model,
      //   // TODO: Correct these field names based on your Usage table schema
      //   prompt_tokens: estimatedTokens, 
      //   completion_tokens: Math.ceil((response.generatedText?.length || 0) / 4),
      //   credits_used: requiredCredits,
      // });
      // await updateUserCredits(userId, -requiredCredits);

      const streamContext = activeStreamManager.get(requestId);
      if (streamContext && Object.keys(streamContext.toolCalls).length === 0 && !response.waitingForToolCall) {
        activeStreamManager.remove(requestId);
      }
    }).catch(error => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Gemini stream: Unhandled error for ${requestId} - ${errorMessage}`);
      const errorEvent: ClientEvent = { type: 'geminiError', requestId, error: 'Internal server error', message: errorMessage };
      sendEventToClient(userId, errorEvent);
      activeStreamManager.remove(requestId);
    });

    return NextResponse.json({ status: 'streaming_initiated', requestId });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    let requestId = 'unknown_request';
    if (error && typeof error === 'object' && 'requestId' in error && typeof error.requestId === 'string') {
      requestId = error.requestId;
    } else if (req) {
        try {
            const url = new URL(req.url);
            requestId = url.searchParams.get('requestId') || 'unknown_request_from_url';
        } catch {}
    }
    logger.error(`Error in Gemini stream initiation (GET): ${errorMessage}`, { requestId });
    return NextResponse.json({ error: 'Internal server error', message: errorMessage, requestId }, { status: 500 });
  }
}
