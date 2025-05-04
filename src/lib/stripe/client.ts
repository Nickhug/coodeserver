import Stripe from 'stripe';
import { updateUserCredits } from '../supabase/client';

// Initialize Stripe with API key - using any to bypass the version check
// In production we would use a properly typed version
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiVersion: '2023-10-16' as any,
});

// Subscription tiers and their credit allocations
export const subscriptionTiers = {
  free: {
    name: 'Free',
    monthlyCredits: 100,
    price: 0,
    priceId: null,
  },
  basic: {
    name: 'Basic',
    monthlyCredits: 1000,
    price: 9.99,
    priceId: process.env.STRIPE_BASIC_PRICE_ID,
  },
  pro: {
    name: 'Pro',
    monthlyCredits: 5000,
    price: 29.99,
    priceId: process.env.STRIPE_PRO_PRICE_ID,
  },
  enterprise: {
    name: 'Enterprise',
    monthlyCredits: 20000,
    price: 99.99,
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID,
  },
};

export type SubscriptionTier = keyof typeof subscriptionTiers;

/**
 * Create a checkout session for subscribing
 */
export async function createCheckoutSession(
  userId: string,
  tier: SubscriptionTier,
  customerId?: string,
  returnUrl: string = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
) {
  const { priceId } = subscriptionTiers[tier];
  
  if (!priceId) {
    throw new Error(`Invalid tier or missing price ID for tier: ${tier}`);
  }

  try {
    // Create a checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${returnUrl}/settings/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}/settings/billing?canceled=true`,
      metadata: {
        userId,
        tier,
      },
    });

    return { url: session.url, sessionId: session.id };
  } catch (error) {
    console.error('Error creating checkout session:', error);
    throw error;
  }
}

/**
 * Create a customer portal session for managing subscriptions
 */
export async function createCustomerPortalSession(
  customerId: string,
  returnUrl: string = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
) {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${returnUrl}/settings/billing`,
    });

    return { url: session.url };
  } catch (error) {
    console.error('Error creating customer portal session:', error);
    throw error;
  }
}

/**
 * Handle subscription creation or update
 */
export async function handleSubscriptionChange(
  subscription: Stripe.Subscription
) {
  try {
    // Get the subscription's metadata to find the userId
    const { userId, tier } = subscription.metadata as { userId: string; tier: SubscriptionTier };
    
    if (!userId || !tier) {
      throw new Error('Missing userId or tier in subscription metadata');
    }

    // Determine credits to add based on the tier
    const { monthlyCredits } = subscriptionTiers[tier as SubscriptionTier];
    
    // Update user's subscription status and credits in database
    await updateUserCredits(userId, monthlyCredits);

    // TODO: Update user's subscription tier in database
    // await updateUserSubscriptionTier(userId, tier);

    return { success: true, userId, tier, credits: monthlyCredits };
  } catch (error) {
    console.error('Error handling subscription change:', error);
    throw error;
  }
}

/**
 * Verify a Stripe webhook event
 */
export function verifyStripeWebhook(
  payload: string,
  signature: string
): Stripe.Event {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  try {
    return stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret
    );
  } catch (error) {
    console.error('Error verifying Stripe webhook:', error);
    throw error;
  }
} 