import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../../../components/ui/card';
import { GlowingEffect } from '../../../components/ui/glowing-effect';
import { GlowingButton } from '../../../components/ui/glowing-button';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Subscription plan interface
interface SubscriptionPlan {
  id: string;
  name: string;
  price: number;
  interval: string;
  description: string;
  features: string[];
  credits: number;
  recommended?: boolean;
}

// Fetch user subscription from database
async function getUserSubscription(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select('subscription_tier, credits_remaining')
    .eq('clerk_id', userId)
    .single();
  
  if (error) {
    console.error('Error fetching user subscription:', error);
    return null;
  }
  
  return {
    tier: data.subscription_tier || 'free',
    creditsRemaining: data.credits_remaining || 0
  };
}

// Format currency with dollar sign
function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// Get a user stub for development
async function getUser() {
  // In production, you would use clerk.currentUser() here
  return { id: 'user_dev', firstName: 'Developer' };
}

// Replace CheckIcon with a custom component
const CheckIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-[#d81b60] mr-2 flex-shrink-0">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
    <polyline points="22 4 12 14.01 9 11.01"></polyline>
  </svg>
);

export default async function SubscriptionPage() {
  const user = await getUser();
  
  if (!user) {
    redirect('/login');
  }
  
  const subscription = await getUserSubscription(user.id);
  const currentTier = subscription?.tier || 'free';
  
  // Define subscription plans
  const plans: SubscriptionPlan[] = [
    {
      id: 'free',
      name: 'Free',
      price: 0,
      interval: 'month',
      description: 'For personal projects and experimenting with AI',
      features: [
        '100 credits included',
        'Basic code completion',
        'Standard response time',
        'Community support'
      ],
      credits: 100
    },
    {
      id: 'pro',
      name: 'Pro',
      price: 19,
      interval: 'month',
      description: 'For professional developers who need more power',
      features: [
        '1,000 credits included',
        'Advanced code completion',
        'Faster response time',
        'Priority support',
        'Custom instructions'
      ],
      credits: 1000,
      recommended: true
    },
    {
      id: 'team',
      name: 'Team',
      price: 49,
      interval: 'month',
      description: 'For teams collaborating on projects',
      features: [
        '3,000 credits included',
        'Team collaboration features',
        'Fastest response time',
        'Dedicated support',
        'Custom instructions',
        'Usage analytics'
      ],
      credits: 3000
    }
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Subscription</h1>
        <p className="text-white/70">Manage your subscription and credits</p>
      </div>
      
      {/* Current Subscription */}
      <div className="relative">
        <Card className="bg-black/40 border border-white/10 overflow-hidden">
          <GlowingEffect
            spread={40}
            blur={5}
            proximity={80}
            glow={true}
            disabled={false}
            variant="default"
            borderWidth={1}
            inactiveZone={0.01}
          />
          <CardHeader>
            <CardTitle>Current Subscription</CardTitle>
            <CardDescription>
              Your current plan and credits
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-xl font-semibold capitalize">{currentTier} Plan</h3>
                <p className="text-white/70">
                  {subscription?.creditsRemaining} credits remaining
                </p>
              </div>
              <div>
                <GlowingButton
                  variant="outline"
                  size="sm"
                  className="border-[#d81b60]/30"
                >
                  Add Credits
                </GlowingButton>
              </div>
            </div>
            <div className="pt-2">
              <p className="text-sm text-white/60">
                Need more credits? You can purchase additional credits or upgrade your plan to get more included credits.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Subscription Plans */}
      <div>
        <h2 className="text-2xl font-bold mb-6">Available Plans</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map((plan) => (
            <div key={plan.id} className="relative">
              <Card 
                className={`bg-black/40 border overflow-hidden h-full flex flex-col ${
                  plan.recommended 
                    ? 'border-[#d81b60]/30 ring-1 ring-[#d81b60]/20' 
                    : 'border-white/10'
                }`}
              >
                {plan.recommended && (
                  <div className="absolute top-0 right-0 bg-[#d81b60] text-white text-xs px-3 py-1 rounded-bl-lg">
                    Recommended
                  </div>
                )}
                <GlowingEffect
                  spread={40}
                  blur={5}
                  proximity={80}
                  glow={true}
                  disabled={false}
                  variant="default"
                  borderWidth={1}
                  inactiveZone={0.01}
                />
                <CardHeader>
                  <CardTitle>{plan.name}</CardTitle>
                  <CardDescription>
                    {plan.description}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-grow">
                  <div className="mb-6">
                    <span className="text-3xl font-bold">{formatCurrency(plan.price)}</span>
                    <span className="text-white/70">/{plan.interval}</span>
                  </div>
                  <div className="space-y-2">
                    {plan.features.map((feature, index) => (
                      <div key={index} className="flex items-start">
                        <CheckIcon />
                        <span className="text-sm">{feature}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
                <CardFooter>
                  <GlowingButton
                    variant={currentTier === plan.id ? 'outline' : 'default'}
                    size="default"
                    className={`w-full ${
                      currentTier === plan.id 
                        ? 'border-[#d81b60]/30' 
                        : plan.recommended ? 'bg-white text-black hover:bg-white/90' : ''
                    }`}
                  >
                    {currentTier === plan.id ? 'Current Plan' : 'Select Plan'}
                  </GlowingButton>
                </CardFooter>
              </Card>
            </div>
          ))}
        </div>
      </div>
      
      {/* Additional Credit Packages */}
      <div>
        <h2 className="text-2xl font-bold mb-6">Additional Credits</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            { amount: 500, price: 10 },
            { amount: 1000, price: 18 },
            { amount: 3000, price: 45 }
          ].map((pack, index) => (
            <div key={index} className="relative">
              <Card className="bg-black/40 border border-white/10 overflow-hidden">
                <GlowingEffect
                  spread={40}
                  blur={5}
                  proximity={80}
                  glow={true}
                  disabled={false}
                  variant="default"
                  borderWidth={1}
                  inactiveZone={0.01}
                />
                <CardHeader>
                  <CardTitle>{pack.amount} Credits</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="mb-4">
                    <span className="text-2xl font-bold">{formatCurrency(pack.price)}</span>
                  </div>
                  <p className="text-sm text-white/70">
                    {(pack.price / pack.amount * 1000).toFixed(2)}¢ per 1,000 tokens
                  </p>
                </CardContent>
                <CardFooter>
                  <GlowingButton
                    variant="outline"
                    size="default"
                    className="w-full"
                  >
                    Purchase
                  </GlowingButton>
                </CardFooter>
              </Card>
            </div>
          ))}
        </div>
      </div>
      
      {/* Billing History */}
      <div className="relative">
        <Card className="bg-black/40 border border-white/10 overflow-hidden">
          <GlowingEffect
            spread={40}
            blur={5}
            proximity={80}
            glow={true}
            disabled={false}
            variant="default"
            borderWidth={1}
            inactiveZone={0.01}
          />
          <CardHeader>
            <CardTitle>Billing History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8 text-white/50">
              No billing history available
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
} 