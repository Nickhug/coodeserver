import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserWithDb } from '../../../../lib/clerk/auth';
import { sendGeminiRequest } from '../../../../lib/ai-providers/gemini-provider';
import { logger } from '../../../../lib/logger';
import { activeStreamManager, ToolCall } from '../../../../lib/streams/ActiveStreamManager';
import { sendEventToClient, ClientEvent, ExecuteToolClientEvent } from '../../../../../websocket-server/manager';
// import { logUsage } from '../../../../lib/supabase/client'; // Commented out until schema is clear
// import { updateUserCredits } from '../../../../lib/supabase/client'; // Commented out until schema is clear

export async function POST(req: NextRequest) {
  try {
    const userInfo = await getCurrentUserWithDb(req);
    if (!userInfo?.dbUser?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = userInfo.dbUser.id;

    const body = await req.json();
    if (!body.requestId || !body.toolCallId || body.output === undefined) {
      return NextResponse.json({ error: 'Invalid tool result request' }, { status: 400 });
    }

    const { requestId, toolCallId, output } = body;

    if (!activeStreamManager.validateUser(requestId, userId)) {
      logger.warn(`User ${userId} attempted to access unauthorized stream ${requestId}`);
      return NextResponse.json({ error: 'Unauthorized access to stream' }, { status: 403 });
    }

    const streamContext = activeStreamManager.get(requestId);
    if (!streamContext) {
      logger.warn(`Stream ${requestId} not found for tool result`);
      return NextResponse.json({ error: 'Stream not found' }, { status: 404 });
    }

    const { success, updatedMessages } = activeStreamManager.addToolResult(requestId, toolCallId, output);
    if (!success || !updatedMessages) {
      logger.error(`Failed to add tool result for ${requestId}`);
      return NextResponse.json({ error: 'Failed to process tool result' }, { status: 500 });
    }

    activeStreamManager.resumeStream(requestId);
    logger.info(`Continuing Gemini conversation for ${requestId} with tool result for user ${userId}`);

    // Destructure what's needed for sendGeminiRequest, excluding the HTTP controller
    const { systemMessage, tools, model, temperature, maxTokens } = streamContext;

    sendGeminiRequest({
      apiKey: process.env.GEMINI_API_KEY!,
      model,
      messages: updatedMessages, // These are already GeminiMessage[]
      systemMessage,
      temperature,
      maxTokens,
      tools,
      onStream: (text, toolCallUpdate) => {
        // All subsequent stream events go over WebSocket
        if (toolCallUpdate?.id) {
          const newToolCall: ToolCall = { 
            name: toolCallUpdate.name, 
            parameters: { ...(toolCallUpdate.parameters || {}) }, 
            id: toolCallUpdate.id 
          };
          activeStreamManager.trackToolCall(requestId, newToolCall);
          logger.info(`Gemini tool-result stream: New tool call for ${requestId} - ${newToolCall.name}`);
          const toolEvent: ExecuteToolClientEvent = { type: 'executeTool', requestId, toolCall: newToolCall };
          sendEventToClient(userId, toolEvent);
        }
        if (text) {
          logger.debug(`Gemini tool-result stream: Content for ${requestId} - chunk length ${text.length}`);
          const contentEvent: ClientEvent = { type: 'geminiContent', requestId, chunk: text };
          sendEventToClient(userId, contentEvent);
        }
      }
    }).then(async geminiResponse => {
      if (!geminiResponse.success && geminiResponse.error) {
        logger.error(`Gemini tool-result stream: Error for ${requestId} - ${geminiResponse.error}`);
        const errorEvent: ClientEvent = { type: 'geminiError', requestId, error: geminiResponse.error };
        sendEventToClient(userId, errorEvent);
      } else if (geminiResponse.success && !geminiResponse.waitingForToolCall) {
        logger.info(`Gemini tool-result stream: Done for ${requestId}`);
        const doneEvent: ClientEvent = { type: 'geminiDone', requestId };
        sendEventToClient(userId, doneEvent);
      }
      // If waitingForToolCall, we don't send 'done' yet. It will be handled after the next tool result.

      // TODO: Uncomment and verify logUsage and updateUserCredits with correct schema
      // const estimatedContinuationTokens = Math.ceil((geminiResponse.generatedText?.length || 0) / 4);
      // const requiredContinuationCredits = estimatedContinuationTokens / 1000; 
      // await logUsage({
      //   user_id: userId,
      //   provider: 'google',
      //   model: model,
      //   // prompt_tokens: ???, // Need to decide how to track tokens for continuations
      //   completion_tokens: estimatedContinuationTokens,
      //   credits_used: requiredContinuationCredits,
      // });
      // await updateUserCredits(userId, -requiredContinuationCredits);
      
      // Clean up the stream from ActiveStreamManager if it's truly finished and no more tools are pending
      const currentStreamContext = activeStreamManager.get(requestId);
      if (currentStreamContext && Object.keys(currentStreamContext.toolCalls).length === 0 && !geminiResponse.waitingForToolCall) {
         if (!activeStreamManager.get(requestId)?.isPaused) { // Ensure it's not paused waiting for another tool
            activeStreamManager.remove(requestId);
            logger.info(`Gemini tool-result stream: Removed completed stream ${requestId} from manager.`);
         }
      }
    }).catch(error => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Gemini tool-result stream: Unhandled error for ${requestId} - ${errorMessage}`);
      const errorEvent: ClientEvent = { type: 'geminiError', requestId, error: 'Internal server error processing tool result', message: errorMessage };
      sendEventToClient(userId, errorEvent);
      activeStreamManager.remove(requestId); // Clean up on unhandled error
    });

    return NextResponse.json({ status: 'tool_result_processed', requestId });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error in tool-result POST handler: ${errorMessage}`);
    // Attempt to get requestId from body if possible, though body parsing might have failed
    let requestId = 'unknown_request';
    try {
        const bodyForError = await req.json(); // Re-parse or get from context if needed
        requestId = bodyForError.requestId || 'unknown_request_from_body';
    } catch {}

    // We cannot reliably send a WebSocket error here if we don't have userId or valid requestId
    return NextResponse.json({ error: 'Internal server error', message: errorMessage, requestId }, { status: 500 });
  }
} 