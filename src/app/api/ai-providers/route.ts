import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserWithDb } from '../../../lib/clerk/auth';
import { checkUserCredits } from '../../../lib/clerk/auth';
import { ApiProvider, sendLLMRequest } from '../../../lib/ai-providers/providers';
import { updateUserCredits } from '../../../lib/supabase/client';
import { z } from 'zod';

// Validate request body
const requestSchema = z.object({
  provider: z.string(),
  model: z.string(),
  prompt: z.string(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
});

export async function POST(req: NextRequest) {
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

    const { provider, model, prompt, temperature, maxTokens } = result.data;

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
          requiredCredits 
        },
        { status: 402 }
      );
    }

    // Send request to the LLM provider
    const llmResponse = await sendLLMRequest({
      provider: provider as ApiProvider,
      model,
      prompt,
      temperature,
      maxTokens,
      userId: userInfo.dbUser.id,
    });

    // Deduct credits
    await updateUserCredits(userInfo.dbUser.id, -llmResponse.creditsUsed);

    // Return the response
    return NextResponse.json({
      text: llmResponse.text,
      tokensUsed: llmResponse.tokensUsed,
      creditsUsed: llmResponse.creditsUsed,
      creditsRemaining: creditsRemaining - llmResponse.creditsUsed,
    });

  } catch (error) {
    console.error('Error in AI provider API:', error);
    
    return NextResponse.json(
      { error: 'Internal server error', message: (error as Error).message },
      { status: 500 }
    );
  }
}

// Get available providers and models
export async function GET() {
  try {
    // This could be expanded to fetch from a database or filter based on the user's plan
    const providers = {
      openai: ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo'],
      anthropic: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
      groq: ['llama3-70b-8192', 'mixtral-8x7b-32768'],
      mistral: ['mistral-large', 'mistral-medium', 'mistral-small'],
    };

    return NextResponse.json({ providers });
  } catch (error) {
    console.error('Error fetching providers:', error);
    
    return NextResponse.json(
      { error: 'Internal server error', message: (error as Error).message },
      { status: 500 }
    );
  }
} 