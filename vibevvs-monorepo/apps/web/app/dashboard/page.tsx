import { currentUser } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { GlowingEffect } from '../../components/ui/glowing-effect';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Dashboard stats type
interface DashboardStats {
  totalTokensUsed: number;
  creditsRemaining: number;
  subscriptionTier: string;
  recentActivity: {
    date: string;
    provider: string;
    model: string;
    tokensUsed: number;
  }[];
}

// Fetch user stats from database
async function fetchUserStats(clerkId: string): Promise<DashboardStats> {
  // Get user data
  const { data: userData } = await supabase
    .from('users')
    .select('credits_remaining, subscription_tier')
    .eq('clerk_id', clerkId)
    .single();
  
  // Get total tokens used
  const { data: totalTokens, error: tokenError } = await supabase
    .from('usage_logs')
    .select('tokens_used')
    .eq('user_id', clerkId);
  
  const totalTokensUsed = totalTokens?.reduce((sum, item) => sum + item.tokens_used, 0) || 0;
  
  // Get recent activity
  const { data: recentActivity } = await supabase
    .from('usage_logs')
    .select('created_at, provider, model, tokens_used')
    .eq('user_id', clerkId)
    .order('created_at', { ascending: false })
    .limit(5);
  
  return {
    totalTokensUsed,
    creditsRemaining: userData?.credits_remaining || 0,
    subscriptionTier: userData?.subscription_tier || 'free',
    recentActivity: recentActivity?.map(item => ({
      date: new Date(item.created_at).toLocaleString(),
      provider: item.provider,
      model: item.model,
      tokensUsed: item.tokens_used
    })) || []
  };
}

// Format number with commas
function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export default async function DashboardPage() {
  const user = await currentUser();
  
  if (!user) {
    return <div>Please sign in to view your dashboard</div>;
  }

  // Get the Clerk ID for database queries  
  const clerkId = user.id;
  
  const stats = await fetchUserStats(clerkId);
  
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Dashboard</h1>
        <p className="text-white/70">Welcome back, {user.firstName || user.emailAddresses[0].emailAddress}!</p>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Credits Card */}
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
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-medium">Credits Remaining</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{formatNumber(stats.creditsRemaining)}</div>
              <p className="text-xs text-white/60 mt-1">
                Subscription: {stats.subscriptionTier.charAt(0).toUpperCase() + stats.subscriptionTier.slice(1)}
              </p>
            </CardContent>
          </Card>
        </div>
        
        {/* Tokens Used Card */}
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
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-medium">Total Tokens Used</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{formatNumber(stats.totalTokensUsed)}</div>
              <p className="text-xs text-white/60 mt-1">
                Approx. {Math.ceil(stats.totalTokensUsed / 1000)} credits used
              </p>
            </CardContent>
          </Card>
        </div>
        
        {/* Subscription Card */}
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
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-medium">Subscription</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold capitalize">{stats.subscriptionTier}</div>
              <p className="text-xs text-white/60 mt-1">
                {stats.subscriptionTier === 'free' ? 'Upgrade for more features' : 'Active subscription'}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
      
      {/* Recent Activity */}
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
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.recentActivity.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="px-4 py-2 text-left text-xs font-medium text-white/70">Date</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-white/70">Provider</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-white/70">Model</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-white/70">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentActivity.map((activity, index) => (
                      <tr key={index} className="border-b border-white/5 last:border-0">
                        <td className="px-4 py-3 text-sm">{activity.date}</td>
                        <td className="px-4 py-3 text-sm capitalize">{activity.provider}</td>
                        <td className="px-4 py-3 text-sm">{activity.model}</td>
                        <td className="px-4 py-3 text-sm text-right">{formatNumber(activity.tokensUsed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-white/50">No recent activity</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
} 