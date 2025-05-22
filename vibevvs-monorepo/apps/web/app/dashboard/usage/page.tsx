import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { GlowingEffect } from '../../../components/ui/glowing-effect';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Usage data types
interface UsageSummary {
  totalTokens: number;
  byProvider: { provider: string; tokens: number }[];
  byModel: { model: string; tokens: number }[];
  byDate: { date: string; tokens: number }[];
  recentActivity: {
    date: string;
    provider: string;
    model: string;
    tokensUsed: number;
  }[];
}

// Fetch usage data from database
async function fetchUsageData(userId: string): Promise<UsageSummary> {
  // Get total tokens used
  const { data: totalData } = await supabase
    .from('usage_logs')
    .select('tokens_used')
    .eq('user_id', userId);
  
  const totalTokens = totalData?.reduce((sum, item) => sum + item.tokens_used, 0) || 0;
  
  // Get usage by provider
  const { data: providerData } = await supabase
    .from('usage_logs')
    .select('provider, tokens_used')
    .eq('user_id', userId);
  
  const byProvider = providerData ? aggregateByProvider(providerData) : [];
  
  // Get usage by model
  const { data: modelData } = await supabase
    .from('usage_logs')
    .select('model, tokens_used')
    .eq('user_id', userId);
  
  const byModel = modelData ? aggregateByModel(modelData) : [];
  
  // Get usage by date (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const { data: dateData } = await supabase
    .from('usage_logs')
    .select('created_at, tokens_used')
    .eq('user_id', userId)
    .gte('created_at', thirtyDaysAgo.toISOString());
  
  const byDate = dateData 
    ? aggregateByDate(dateData, 'created_at')
    : [];
  
  // Get recent activity
  const { data: recentActivity } = await supabase
    .from('usage_logs')
    .select('created_at, provider, model, tokens_used')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);
  
  return {
    totalTokens,
    byProvider,
    byModel,
    byDate,
    recentActivity: recentActivity?.map(item => ({
      date: new Date(item.created_at).toLocaleString(),
      provider: item.provider,
      model: item.model,
      tokensUsed: item.tokens_used
    })) || []
  };
}

// Helper function to aggregate data by a specific field for providers
function aggregateByProvider(data: any[]): { provider: string; tokens: number }[] {
  const aggregated = data.reduce((acc, item) => {
    const key = item.provider;
    if (!acc[key]) {
      acc[key] = 0;
    }
    acc[key] += item.tokens_used;
    return acc;
  }, {} as Record<string, number>);
  
  return Object.entries(aggregated).map(([provider, tokens]) => ({
    provider,
    tokens: tokens as number
  }));
}

// Helper function to aggregate data by a specific field for models
function aggregateByModel(data: any[]): { model: string; tokens: number }[] {
  const aggregated = data.reduce((acc, item) => {
    const key = item.model;
    if (!acc[key]) {
      acc[key] = 0;
    }
    acc[key] += item.tokens_used;
    return acc;
  }, {} as Record<string, number>);
  
  return Object.entries(aggregated).map(([model, tokens]) => ({
    model,
    tokens: tokens as number
  }));
}

// Helper function to aggregate data by date
function aggregateByDate(data: any[], dateField: string): { date: string; tokens: number }[] {
  const aggregated = data.reduce((acc, item) => {
    const date = new Date(item[dateField]).toLocaleDateString();
    if (!acc[date]) {
      acc[date] = 0;
    }
    acc[date] += item.tokens_used;
    return acc;
  }, {});
  
  return Object.entries(aggregated).map(([date, tokens]) => ({
    date,
    tokens: tokens as number
  })).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// Format number with commas
function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Get a user stub for development
async function getUser() {
  // In production, you would use clerk.currentUser() here
  return { id: 'user_dev', firstName: 'Developer' };
}

export default async function UsagePage() {
  const user = await getUser();
  
  if (!user) {
    redirect('/login');
  }
  
  const usageData = await fetchUsageData(user.id);
  
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Usage Analytics</h1>
        <p className="text-white/70">Track your token usage and activity</p>
      </div>
      
      {/* Usage Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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
              <CardTitle className="text-lg font-medium">Total Tokens</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{formatNumber(usageData.totalTokens)}</div>
              <p className="text-xs text-white/60 mt-1">
                Across all models and providers
              </p>
            </CardContent>
          </Card>
        </div>
        
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
              <CardTitle className="text-lg font-medium">Approx. Cost</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{Math.ceil(usageData.totalTokens / 1000)} credits</div>
              <p className="text-xs text-white/60 mt-1">
                Based on 1,000 tokens per credit
              </p>
            </CardContent>
          </Card>
        </div>
        
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
              <CardTitle className="text-lg font-medium">30-Day Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{usageData.byDate.length}</div>
              <p className="text-xs text-white/60 mt-1">
                Days with recorded activity
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
      
      {/* Usage by Provider */}
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
            <CardTitle>Usage by Provider</CardTitle>
          </CardHeader>
          <CardContent>
            {usageData.byProvider.length > 0 ? (
              <div className="space-y-4">
                {usageData.byProvider.map((item, index) => {
                  const percentage = Math.round((item.tokens / usageData.totalTokens) * 100);
                  return (
                    <div key={index} className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="capitalize">{item.provider}</span>
                        <span>{formatNumber(item.tokens)} tokens ({percentage}%)</span>
                      </div>
                      <div className="w-full bg-white/5 rounded-full h-2">
                        <div 
                          className="bg-gradient-to-r from-[#d81b60] to-[#d81b60]/70 h-2 rounded-full" 
                          style={{ width: `${percentage}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-white/50">No provider data available</div>
            )}
          </CardContent>
        </Card>
      </div>
      
      {/* Usage by Model */}
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
            <CardTitle>Usage by Model</CardTitle>
          </CardHeader>
          <CardContent>
            {usageData.byModel.length > 0 ? (
              <div className="space-y-4">
                {usageData.byModel.map((item, index) => {
                  const percentage = Math.round((item.tokens / usageData.totalTokens) * 100);
                  return (
                    <div key={index} className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>{item.model}</span>
                        <span>{formatNumber(item.tokens)} tokens ({percentage}%)</span>
                      </div>
                      <div className="w-full bg-white/5 rounded-full h-2">
                        <div 
                          className="bg-gradient-to-r from-[#d81b60]/80 to-[#d81b60]/50 h-2 rounded-full" 
                          style={{ width: `${percentage}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-white/50">No model data available</div>
            )}
          </CardContent>
        </Card>
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
            <CardTitle>Detailed Activity Log</CardTitle>
          </CardHeader>
          <CardContent>
            {usageData.recentActivity.length > 0 ? (
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
                    {usageData.recentActivity.map((activity, index) => (
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
              <div className="text-center py-8 text-white/50">No activity data available</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
} 