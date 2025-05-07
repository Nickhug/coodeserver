import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getCurrentUserWithDb } from '../../../../lib/clerk/auth';
import { checkUserCredits } from '../../../../lib/clerk/auth';
import { updateUserCredits } from '../../../../lib/supabase/client';
import { sendAnthropicRequest } from '../../../../lib/ai-providers/anthropic-provider';
import { logUsage } from '../../../../lib/supabase/client';
import { logger } from '../../../../lib/logger';
import { createCorsResponse } from '../../../../lib/api-utils';

// Define the request schema
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([z.string(), z.any()]),
      anthropicReasoning: z.any().optional(),
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

/**
 * Handle OPTIONS requests for CORS preflight
 */
export async function OPTIONS() {
  return createCorsResponse({}, 200);
}

/**
 * Streaming API endpoint for Anthropic
 */
export async function POST(req: NextRequest) {
  // Set up response headers for streaming
  const encoder = new TextEncoder();
  const customReadable = new ReadableStream({
    async start(controller) {
      try {
        logger.info('Anthropic streaming request received');

        // Authenticate user - pass request to support token-based auth
        const userInfo = await getCurrentUserWithDb(req);
        if (!userInfo) {
          logger.warn('Unauthorized access attempt to Anthropic streaming endpoint');
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
          logger.warn('Invalid request to Anthropic streaming endpoint', {
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

        // Check if user has enough credits
        const { creditsRemaining, hasEnoughCredits } = await checkUserCredits(userInfo.dbUser.id);
        if (!hasEnoughCredits) {
          logger.warn(`User ${userInfo.dbUser.id} has insufficient credits for Anthropic request`);
          controller.enqueue(encoder.encode(JSON.stringify({
            event: 'error',
            error: 'Insufficient credits',
            message: 'You do not have enough credits to make this request. Please purchase more credits.'
          })));
          controller.close();
          return;
        }

        logger.info(`Processing Anthropic streaming request for user ${userInfo.dbUser.id}`, {
          model,
          requestId
        });

        // Send initial response to confirm stream started
        controller.enqueue(encoder.encode(JSON.stringify({
          event: 'start',
          requestId
        })));

        // Variable to track accumulated text
        let fullText = '';

        // Ensure messages are in a format that sendAnthropicRequest can handle
        const formattedMessages = messages.map(message => {
          // Return the message as is - the conversion will happen in sendAnthropicRequest
          return message;
        });

        // Log tools if present
        if (tools && tools.length > 0) {
          logger.info(`Tools present: ${tools.length} tools`);
          logger.info(`Tools preview: ${JSON.stringify(tools.map(t => t.name))}`);
        } else {
          logger.info(`No tools provided`);
        }

        // Send request to Anthropic with streaming
        const response = await sendAnthropicRequest({
          apiKey: process.env.ANTHROPIC_API_KEY!,
          model,
          messages: formattedMessages,
          systemMessage,
          temperature,
          maxTokens,
          tools,
          onStream: (text) => {
            // Send chunk to client
            controller.enqueue(encoder.encode(JSON.stringify({
              event: 'chunk',
              text,
              requestId
            })));
            // Accumulate text
            fullText += text;
          }
        });

        // Deduct credits
        await updateUserCredits(userInfo.dbUser.id, -response.creditsUsed);

        logger.info(`Completed Anthropic streaming request for user ${userInfo.dbUser.id}`, {
          tokensUsed: response.tokensUsed,
          creditsUsed: response.creditsUsed,
          model,
          requestId
        });

        // Log usage
        await logUsage({
          user_id: userInfo.dbUser.id,
          provider: 'anthropic',
          model,
          tokens_used: response.tokensUsed,
          credits_used: response.creditsUsed,
        });

        // Send final response
        controller.enqueue(encoder.encode(JSON.stringify({
          event: 'end',
          fullText: response.text,
          tokensUsed: response.tokensUsed,
          creditsUsed: response.creditsUsed,
          creditsRemaining: creditsRemaining - response.creditsUsed,
          toolCall: response.toolCall,
          anthropicReasoning: response.anthropicReasoning,
          requestId
        })));

        // Close the stream
        controller.close();
      } catch (error) {
        logger.error('Error in Anthropic streaming endpoint', {
          error: (error as Error).message
        });

        // Send error to client
        controller.enqueue(encoder.encode(JSON.stringify({
          event: 'error',
          error: 'Server error',
          message: (error as Error).message
        })));

        // Close the stream
        controller.close();
      }
    }
  });

  // Return the stream response
  return new Response(customReadable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': 'vscode-file://vscode-app',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
