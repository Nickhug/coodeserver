"use client"; // Convert to Client Component

import { SignIn } from "@clerk/nextjs";
import { useAuth } from "@clerk/nextjs"; // Use client-side auth hook
import { useSearchParams, useRouter } from "next/navigation"; // Use client-side hooks
import { useEffect } from "react"; // Import useEffect

// Remove the explicit interface definition
// interface LoginPageProps {
//   params: { [key: string]: string }; 
//   searchParams: { [key: string]: string | string[] | undefined };
// }

export default function LoginPage() {
  const { userId } = useAuth(); // Check auth status client-side
  const searchParams = useSearchParams(); // Get search params client-side
  const router = useRouter(); // Get router for client-side redirect

  // Effect to redirect if already logged in
  useEffect(() => {
    if (userId) {
      router.replace("/"); // Use replace to avoid adding to history
    }
  }, [userId, router]);
  
  // Extract connection_id from URL if present (for WebSocket auth flow)
  const connectionId = searchParams.get('connection_id');
  
  // Determine where to redirect after auth
  const redirectUrl = connectionId 
    ? `/api/auth/callback?connection_id=${connectionId}`
    : '/api/auth/callback';
  
  // If user is already logged in (or redirecting), render null or a loading state
  if (userId) {
    return null; // Or a loading indicator
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 bg-gray-50">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900">
            Sign in to VVS
          </h1>
          <p className="mt-2 text-gray-600">
            Access your AI features and settings
          </p>
        </div>
        
        <div className="mt-8 bg-white p-8 shadow rounded-lg">
          <SignIn 
            redirectUrl={redirectUrl}
            appearance={{
              elements: {
                formButtonPrimary: "bg-blue-600 hover:bg-blue-700",
                headerTitle: "hidden",
                headerSubtitle: "hidden",
                footerAction: "text-blue-600",
                card: "shadow-none"
              }
            }}
          />
        </div>
      </div>
    </div>
  );
} 