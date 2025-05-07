import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getCurrentUserWithDb } from '../../../../lib/clerk/auth';
import { checkUserCredits } from '../../../../lib/clerk/auth';
import { updateUserCredits } from '../../../../lib/supabase/client';
import { sendGeminiRequest } from '../../../../lib/ai-providers/gemini-provider';
import { logUsage } from '../../../../lib/supabase/client';
import { logger } from '../../../../lib/logger';
import { createCorsResponse } from '../../../../lib/api-utils';

// Validate request body
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system', 'model']),
      // Support both standard content field and Gemini-style parts array
      content: z.string().or(z.any()).optional(),
      parts: z.array(z.any()).optional(),
      displayContent: z.string().optional(), // Support Void's displayContent field
      reasoning: z.string().optional(), // Support Void's reasoning field
      anthropicReasoning: z.any().optional(), // Support Void's anthropicReasoning field
    })
  ),
  systemMessage: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  requestId: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.record(z.object({
        description: z.string(),
      })),
    })
  ).optional(),
  providerName: z.string().optional(), // Support Void's providerName field
  isServerRequest: z.boolean().optional(), // Support Void's isServerRequest field
});

// Define interface for tracked tool calls
interface TrackedToolCall {
  name: string;
  parameters: Record<string, unknown>;
  id: string;
}

/**
 * Handle OPTIONS requests for CORS preflight
 */
export async function OPTIONS() {
  return createCorsResponse({}, 200);
}

/**
 * Streaming API endpoint for Gemini
 */
export async function POST(req: NextRequest) {
  // Set up response headers for streaming
  const encoder = new TextEncoder();
  const customReadable = new ReadableStream({
    async start(controller) {
      try {
        logger.info('Gemini streaming request received');

        // Authenticate user - pass request to support token-based auth
        const userInfo = await getCurrentUserWithDb(req);
        if (!userInfo) {
          logger.warn('Unauthorized access attempt to Gemini streaming endpoint');
          controller.enqueue(encoder.encode(JSON.stringify({
            event: 'error',
            error: 'Unauthorized',
            message: 'Authentication failed. Please log in again.'
          })));
          controller.close();
          return;
        }

        // Parse request body
        const body = await req.json();
        const result = requestSchema.safeParse(body);

        if (!result.success) {
          logger.warn('Invalid request to Gemini streaming endpoint', {
            details: result.error.format()
          });
          controller.enqueue(encoder.encode(JSON.stringify({
            error: 'Invalid request',
            details: result.error.format()
          })));
          controller.close();
          return;
        }

        const {
          model,
          messages,
          systemMessage,
          temperature,
          maxTokens,
          requestId,
          tools
        } = result.data;

        // Log the received messages for debugging
        logger.debug(`Received messages: ${JSON.stringify(messages)}`);
        logger.debug(`Received message structure: ${JSON.stringify(messages.map(m => Object.keys(m)))}`);

        // For credit estimation, extract text content where possible
        const textContents = messages.map(m => {
          if (m.parts && Array.isArray(m.parts)) {
            // Extract text from parts array
            return m.parts.map((part: any) => {
              if (part.text !== undefined) {
                return part.text;
              } else if (part.data !== undefined) {
                return '[IMAGE DATA]'; // Placeholder for binary data
              } else {
                return JSON.stringify(part);
              }
            }).join(' ');
          } else if (typeof m.content === 'string') {
            return m.content;
          } else if (m.displayContent) {
            return m.displayContent;
          } else if (m.content) {
            return JSON.stringify(m.content);
          }
          return '';
        });

        // Estimate required credits (conservative estimate)
        const prompt = textContents.join(' ');
        const estimatedTokens = Math.ceil(prompt.length / 4) * 2; // Double to account for response
        const requiredCredits = estimatedTokens / 1000; // Rough conversion

        // Check if user has enough credits - pass the request for token auth
        const { hasCredits, creditsRemaining } = await checkUserCredits(requiredCredits, req);

        if (!hasCredits) {
          logger.warn(`Insufficient credits for user ${userInfo.dbUser.id}`, {
            creditsRemaining,
            requiredCredits
          });
          controller.enqueue(encoder.encode(JSON.stringify({
            error: 'Insufficient credits',
            creditsRemaining,
            requiredCredits,
            requestId
          })));
          controller.close();
          return;
        }

        logger.info(`Processing Gemini streaming request for user ${userInfo.dbUser.id}`, {
          model,
          requestId
        });

        // Send initial response to confirm stream started
        controller.enqueue(encoder.encode(JSON.stringify({
          event: 'start',
          requestId
        })));

        // Variable to track accumulated text and tool calls
        let fullText = '';
        const toolCalls: Record<string, TrackedToolCall> = {};

        // Ensure messages are in a format that sendGeminiRequest can handle
        const formattedMessages = messages;

        // Log system message and tools if present
        if (systemMessage) {
          logger.debug(`System message present, length: ${systemMessage.length}`);
          logger.debug(`System message preview: ${systemMessage.substring(0, 200)}...`);
        }

        if (tools && tools.length > 0) {
          logger.debug(`Tools present: ${tools.length} tools`);
          logger.debug(`Tools preview: ${JSON.stringify(tools.map(t => t.name))}`);
        }

        // Send request to Gemini with streaming
        const response = await sendGeminiRequest({
          apiKey: process.env.GEMINI_API_KEY!,
          model,
          messages: formattedMessages,
          systemMessage,
          temperature,
          maxTokens,
          tools,
          onStream: (text, toolCallUpdate) => {
            // If we have text content, send it
            if (text) {
              controller.enqueue(encoder.encode(JSON.stringify({
                event: 'chunk',
                text,
                requestId
              })));

              // Accumulate text
              fullText += text;
            }
            
            // Handle tool call if present
            if (toolCallUpdate) {
              const { name, parameters, id } = toolCallUpdate;
              
              // Make sure we have a valid ID
              if (id) {
                // Track this tool call
                if (!toolCalls[id]) {
                  toolCalls[id] = { 
                    name, 
                    parameters: { ...(parameters || {}) }, 
                    id 
                  };
                } else {
                  // Update existing tool call parameters
                  toolCalls[id].parameters = { 
                    ...toolCalls[id].parameters, 
                    ...(parameters || {}) 
                  };
                }

                // Log the tool call for debugging
                logger.info(`Tool call in stream: ${name}, ID: ${id}`);
                
                // Send the tool call to the client
                controller.enqueue(encoder.encode(JSON.stringify({
                  event: 'tool',
                  toolCall: {
                    name,
                    parameters: parameters || {},
                    id
                  },
                  requestId
                })));
              }
            }
          }
        });

        // Deduct credits
        await updateUserCredits(userInfo.dbUser.id, -response.creditsUsed);

        // Send final response to confirm stream completion
        controller.enqueue(encoder.encode(JSON.stringify({
          event: 'end',
          text: fullText,
          tokensUsed: response.tokensUsed,
          creditsUsed: response.creditsUsed,
          toolCall: response.toolCall,
          requestId
        })));

        logger.info(`Completed Gemini streaming request for user ${userInfo.dbUser.id}`, {
          tokensUsed: response.tokensUsed,
          creditsUsed: response.creditsUsed,
          model,
          requestId
        });

        // Log usage
        await logUsage({
          user_id: userInfo.dbUser.id,
          provider: 'gemini',
          model,
          credits_used: response.creditsUsed,
          tokens_used: response.tokensUsed,
        }).catch(error => {
          logger.error('Failed to log usage', error);
        });

        controller.close();
      } catch (error: any) {
        logger.error('Error in Gemini streaming request:', error);
        controller.enqueue(encoder.encode(JSON.stringify({
          event: 'error',
          error: error.message || 'Internal Server Error',
          requestId: error.requestId || ''
        })));
        controller.close();
      }
    }
  });

  // Return streaming response with proper headers
  return new Response(customReadable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}
