/**
 * Client API for AI providers
 * This file contains the server-side implementation of the AI provider API
 * that matches the client-side implementation in @vvs/
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUserWithDb } from '../../lib/clerk/auth';
import { checkUserCredits } from '../../lib/clerk/auth';
import { updateUserCredits } from '../../lib/supabase/client';
import { ApiProvider, sendLLMRequest } from './providers';

// Define types that match the client-side types
export type LLMChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type LLMFIMMessage = {
  prefix: string;
  suffix: string;
  stopTokens?: string[];
};

export type ChatMode = 'agent' | 'gather' | 'normal';

// Request schema for chat messages
const chatRequestSchema = z.object({
  providerName: z.string(),
  modelName: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
    })
  ),
  separateSystemMessage: z.string().optional(),
  chatMode: z.enum(['agent', 'gather', 'normal']).nullable().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  requestId: z.string(),
});

// Request schema for FIM (Fill In Middle) messages
const fimRequestSchema = z.object({
  providerName: z.string(),
  modelName: z.string(),
  messages: z.object({
    prefix: z.string(),
    suffix: z.string(),
    stopTokens: z.array(z.string()).optional(),
  }),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  requestId: z.string(),
});

// Combined request schema
const requestSchema = z.object({
  messagesType: z.enum(['chatMessages', 'FIMMessage']),
  providerName: z.string(),
  modelName: z.string(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  requestId: z.string(),
}).and(
  z.union([
    z.object({
      messagesType: z.literal('chatMessages'),
      messages: z.array(
        z.object({
          role: z.enum(['user', 'assistant', 'system']),
          content: z.string(),
        })
      ),
      separateSystemMessage: z.string().optional(),
      chatMode: z.enum(['agent', 'gather', 'normal']).nullable().optional(),
    }),
    z.object({
      messagesType: z.literal('FIMMessage'),
      messages: z.object({
        prefix: z.string(),
        suffix: z.string(),
        stopTokens: z.array(z.string()).optional(),
      }),
    }),
  ])
);

// Map client provider names to server provider names
const providerNameMap: Record<string, ApiProvider> = {
  'openAI': 'openai',
  'groq': 'groq',
  'mistral': 'mistral',
  'ollama': 'ollama',
  'openAICompatible': 'custom',
  'deepseek': 'custom',
  'openRouter': 'custom',
  'gemini': 'gemini',
  'xAI': 'custom',
  'vLLM': 'custom',
  'lmStudio': 'custom',
  'liteLLM': 'custom',
  'microsoftAzure': 'custom',
};

/**
 * Handle AI provider requests from the client
 */
export async function handleClientRequest(req: NextRequest) {
  try {
    // Authenticate user
    const userInfo = await getCurrentUserWithDb();
    if (!userInfo) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Parse request body
    const body = await req.json();
    const result = requestSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: result.error.format() },
        { status: 400 }
      );
    }

    const {
      providerName,
      modelName,
      messagesType,
      temperature,
      maxTokens,
      requestId
    } = result.data;

    // Prepare prompt based on message type
    let prompt: string;
    if (messagesType === 'chatMessages') {
      // For chat messages, format them according to the provider's expected format
      // This is a simplified version - in production, you'd need to handle different provider formats
      const messages = result.data.messages;
      const systemMessage = result.data.separateSystemMessage ||
        messages.find(m => m.role === 'system')?.content || '';

      // Format messages into a prompt
      prompt = systemMessage ? `System: ${systemMessage}\n\n` : '';
      prompt += messages
        .filter(m => m.role !== 'system')
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
    } else {
      // For FIM messages, use the prefix as the prompt
      prompt = result.data.messages.prefix;
    }

    // Estimate required credits (conservative estimate)
    const estimatedTokens = Math.ceil(prompt.length / 4) * 2; // Double to account for response
    const requiredCredits = estimatedTokens / 10; // Rough conversion

    // Check if user has enough credits
    const { hasCredits, creditsRemaining } = await checkUserCredits(requiredCredits);

    if (!hasCredits) {
      return NextResponse.json(
        {
          error: 'Insufficient credits',
          creditsRemaining,
          requiredCredits,
          requestId
        },
        { status: 402 }
      );
    }

    // Send request to the LLM provider
    const serverProviderName = providerNameMap[providerName] || 'custom';

    // Special handling for Gemini provider
    if (serverProviderName === 'gemini') {
      // For Gemini, we'll use the dedicated endpoints
      // The client will handle streaming and file uploads directly with those endpoints
      return NextResponse.json({
        useSpecialEndpoint: true,
        provider: 'gemini',
        streamEndpoint: '/api/void/gemini-stream',
        uploadEndpoint: '/api/void/gemini-upload',
        requestId
      });
    }



    // For other providers, use the standard approach
    const llmResponse = await sendLLMRequest({
      provider: serverProviderName as ApiProvider,
      model: modelName,
      prompt,
      temperature,
      maxTokens,
      userId: userInfo.dbUser.id,
    });

    // Deduct credits
    await updateUserCredits(userInfo.dbUser.id, -llmResponse.creditsUsed);

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

    return NextResponse.json(
      {
        error: 'Internal server error',
        message: (error as Error).message,
        requestId: (await req.json()).requestId || 'unknown'
      },
      { status: 500 }
    );
  }
}
