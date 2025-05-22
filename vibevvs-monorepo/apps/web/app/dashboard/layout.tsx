import { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { Navbar } from '../../components/ui/navbar';
import Link from 'next/link';
import { BackgroundGradient } from '../../components/ui/background-gradient';
import AnimatedLogo from '../../components/AnimatedLogo';
import DashboardSidebar from '../../components/DashboardSidebar';

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await currentUser();
  
  if (!user) {
    redirect('/login');
  }
  
  return (
    <div className="min-h-screen bg-black">
      <Navbar 
        transparent={false}
        sticky={true}
        rightAlignMenu={true}
        menuItems={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Usage", href: "/dashboard/usage" },
          { label: "Subscription", href: "/dashboard/subscription" },
          { label: "Settings", href: "/dashboard/settings" },
        ]}
        logo={
          <Link href="/" className="flex items-center h-10 md:h-12">
            <div className="flex items-center">
              <AnimatedLogo width={79.2} height={31.68} />
              <span 
                className="text-2xl font-bold tracking-tight ml-[-5px] flex items-center" 
                style={{ 
                  fontFamily: 'var(--font-cooper)',
                  transform: 'translateY(-1px)'
                }}
              >
                COODE
              </span>
            </div>
          </Link>
        }
      />

      <div className="flex min-h-[calc(100vh-64px)] pt-16">
        <DashboardSidebar />
        <main className="flex-1 p-6 md:p-8 lg:p-10">
          <div className="w-full h-full rounded-xl overflow-hidden shadow-md border border-white/5 p-6 bg-gradient-to-br from-black to-gray-900/80">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
} 