"use client";

import { SignIn } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isVvsFlow, setIsVvsFlow] = useState(false);
  
  // Check if this is a VVS login flow (presence of connection_id)
  const connectionId = searchParams?.get('connection_id');
  
  useEffect(() => {
    if (connectionId) {
      setIsVvsFlow(true);
    }
  }, [connectionId]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-black">
      <div className="w-full max-w-md">
        <SignIn 
          appearance={{
            elements: {
              rootBox: "mx-auto",
              card: "bg-black/40 border border-white/10 shadow-xl",
              headerTitle: "text-white",
              headerSubtitle: "text-white/70",
              formButtonPrimary: "bg-[#d81b60] hover:bg-[#d81b60]/90",
              footerActionLink: "text-[#d81b60] hover:text-[#d81b60]/90",
              formFieldInput: "bg-black/60 border-white/10 text-white",
              formFieldLabel: "text-white/70",
              identityPreview: "bg-black/60 border-white/10"
            }
          }}
          path="/login"
          afterSignInUrl={isVvsFlow && connectionId ? `/api/auth/send-auth?connection_id=${connectionId}` : '/dashboard'}
          signUpUrl="/sign-up"
        />
        
        {isVvsFlow && (
          <div className="mt-4 text-center">
            <p className="text-white/70 text-sm">
              Signing in for VVS integration. You'll be redirected back to the editor after login.
            </p>
          </div>
        )}
      </div>
    </div>
  );
} 