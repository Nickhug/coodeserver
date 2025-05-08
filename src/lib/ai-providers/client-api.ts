/**
 * Client API for AI providers
 * This file contains the server-side implementation of the AI provider API
 * that matches the client-side implementation in @vvs/
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUserWithDb, checkUserCredits } from '@/lib/clerk/auth.js';
import { updateUserCredits } from '@/lib/supabase/client.js';
import { ApiProvider, sendLLMRequest } from './providers.js';

// Define types that match the client-side types
const ProviderNameSchema = z.enum([
  'OpenAI', 'Groq', 'Mistral', 'Ollama', 'Gemini'
]);
type ProviderName = z.infer<typeof ProviderNameSchema>;

const RequestBodySchema = z.object({
  providerName: ProviderNameSchema,
  modelName: z.string(),
  requestId: z.string(),
  prompt: z.string(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
});

// Map client-side provider names to server-side names
const providerNameMap: Record<ProviderName, ApiProvider | 'custom'> = {
  OpenAI: 'openai',
  Groq: 'groq',
  Mistral: 'mistral',
  Ollama: 'ollama',
  Gemini: 'gemini', // Use the dedicated Gemini implementation
};

export async function POST(req: NextRequest) {
  try {
    // Authenticate user
    const userInfo = await getCurrentUserWithDb();
    if (!userInfo || !userInfo.dbUser) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    const userId = userInfo.dbUser.clerk_id; // Correctly get Clerk ID

    // Parse request body
    let requestBody;
    try {
      requestBody = RequestBodySchema.parse(await req.json());
    } catch (validationError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: validationError },
        { status: 400 }
      );
    }

    const {
      providerName,
      modelName,
      requestId,
      prompt,
      temperature,
      maxTokens,
    } = requestBody;

    // Calculate required credits (example: based on model or prompt length)
    const requiredCredits = 1; // Replace with actual calculation if needed

    // Check if user has enough credits using the function that gets the current user
    const { hasCredits, creditsRemaining } = await checkUserCredits(requiredCredits);

    if (!hasCredits) {
      return NextResponse.json(
        {
          error: 'Insufficient credits',
          creditsRemaining,
          requiredCredits,
          requestId
        },
        { status: 402 } // Payment Required status code
      );
    }

    // Map to server-side provider name
    const serverProviderName = providerNameMap[providerName];

    // Special handling for Gemini provider
    if (serverProviderName === 'gemini') {
      // Instruct the client to use WebSocket for Gemini
      return NextResponse.json({
        useWebSocket: true,
        provider: 'gemini',
        wsEndpoint: '/api/void/gemini-ws', // Provide the WebSocket endpoint
        requestId
      });
    }

    // For other providers, use the standard HTTP request approach
    const llmResponse = await sendLLMRequest({
      provider: serverProviderName as ApiProvider, // Cast since we handled Gemini
      model: modelName,
      prompt,
      temperature,
      maxTokens,
      userId: userId, // Pass the Clerk ID
    });

    // Deduct credits
    // Use clerk_id to update credits in Supabase
    await updateUserCredits(userId, -llmResponse.creditsUsed);

    // Return the response in the format expected by the client
    return NextResponse.json({
      fullText: llmResponse.text,
      fullReasoning: '', // Add reasoning if available from the provider
      requestId,
      tokensUsed: llmResponse.tokensUsed,
      creditsUsed: llmResponse.creditsUsed,
      creditsRemaining: creditsRemaining - llmResponse.creditsUsed,
    });

  } catch (error) {
    console.error('Error in AI provider client API:', error);

    let errorRequestId = 'unknown';
    try {
      // Try to get requestId from the original request if possible
      const originalBody = await req.json();
      errorRequestId = originalBody?.requestId || 'unknown';
    } catch {
      // Ignore if parsing fails
    }

    return NextResponse.json(
      {
        error: 'Internal server error',
        message: (error as Error).message,
        requestId: errorRequestId
      },
      { status: 500 }
    );
  }
}