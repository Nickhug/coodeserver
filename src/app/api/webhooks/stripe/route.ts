import { NextRequest, NextResponse } from 'next/server';
import { verifyStripeWebhook, handleSubscriptionChange } from '../../../../lib/stripe/client';
import Stripe from 'stripe';

export async function POST(req: NextRequest) {
  try {
    // Get the stripe signature from the headers
    const signature = req.headers.get('stripe-signature');
    
    if (!signature) {
      return NextResponse.json(
        { error: 'Missing stripe-signature header' },
        { status: 400 }
      );
    }

    // Get the raw body text
    const payload = await req.text();
    
    // Verify the webhook payload with Stripe
    const event = verifyStripeWebhook(payload, signature);
    
    // Handle different event types
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        
        // Get the subscription ID from the session
        const subscriptionId = session.subscription as string;
        if (!subscriptionId) {
          return NextResponse.json(
            { error: 'No subscription ID in session' },
            { status: 400 }
          );
        }
        
        // Get the full subscription to access all data
        // Using any to bypass version issues - in production use proper typing
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
          apiVersion: '2023-10-16' as any,
        });
        
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await handleSubscriptionChange(subscription);
        
        break;
      }
      
      case 'customer.subscription.created': 
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionChange(subscription);
        break;
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        // Handle subscription cancellation
        // Just log for now, we'll implement user tier update in production
        console.log(`Subscription ${subscription.id} was cancelled`);
        break;
      }
      
      // Add handlers for other webhook events as needed
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
    
    // Return a 200 response to acknowledge receipt of the event
    return NextResponse.json({ received: true });
    
  } catch (error) {
    console.error('Error handling Stripe webhook:', error);
    
    return NextResponse.json(
      { error: 'Webhook error', message: (error as Error).message },
      { status: 400 }
    );
  }
} 