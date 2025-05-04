import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserWithDb } from '../../../lib/clerk/auth';
import { getUserUsage } from '../../../lib/supabase/client';

// Define more specific types for usage data
type TokenUsage = {
  tokensUsed: number;
  creditsUsed: number;
};

type ModelUsage = Record<string, TokenUsage>;

type ProviderUsage = {
  tokensUsed: number;
  creditsUsed: number;
  models: ModelUsage;
};

type ProviderBreakdown = Record<string, ProviderUsage>;

/**
 * Get the authenticated user's usage data
 */
export async function GET(req: NextRequest) {
  try {
    // Authenticate user
    const userInfo = await getCurrentUserWithDb();
    if (!userInfo) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get query parameters for date filtering
    const { searchParams } = new URL(req.url);
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;

    // Get usage data from database
    const usage = await getUserUsage(
      userInfo.dbUser.id,
      startDate,
      endDate
    );

    if (!usage) {
      return NextResponse.json(
        { error: 'Failed to fetch usage data' },
        { status: 500 }
      );
    }

    // Calculate totals
    const totals = usage.reduce(
      (acc, entry) => {
        acc.tokensUsed += entry.tokens_used;
        acc.creditsUsed += entry.credits_used;
        return acc;
      },
      { tokensUsed: 0, creditsUsed: 0 }
    );

    // Group usage by provider
    const byProvider = usage.reduce((acc, entry) => {
      if (!acc[entry.provider]) {
        acc[entry.provider] = {
          tokensUsed: 0,
          creditsUsed: 0,
          models: {},
        };
      }

      acc[entry.provider].tokensUsed += entry.tokens_used;
      acc[entry.provider].creditsUsed += entry.credits_used;

      if (!acc[entry.provider].models[entry.model]) {
        acc[entry.provider].models[entry.model] = {
          tokensUsed: 0,
          creditsUsed: 0,
        };
      }

      acc[entry.provider].models[entry.model].tokensUsed += entry.tokens_used;
      acc[entry.provider].models[entry.model].creditsUsed += entry.credits_used;

      return acc;
    }, {} as ProviderBreakdown);

    return NextResponse.json({
      usage,
      totals,
      byProvider,
      creditsRemaining: userInfo.dbUser.credits_remaining,
    });

  } catch (error) {
    console.error('Error fetching usage data:', error);
    
    return NextResponse.json(
      { error: 'Internal server error', message: (error as Error).message },
      { status: 500 }
    );
  }
} 