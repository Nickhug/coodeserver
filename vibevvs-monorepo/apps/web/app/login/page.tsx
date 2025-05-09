"use client";

import { SignIn } from "@clerk/nextjs";
import { useAuth } from "@clerk/nextjs";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function LoginPage() {
  const { userId, isSignedIn } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Extract connection_id from URL if present (for WebSocket auth flow)
  const connectionId = searchParams.get('connection_id');

  // Effect to handle authentication flow
  useEffect(() => {
    // If we have a connection ID and the user is signed in, handle the WebSocket auth
    if (connectionId && isSignedIn && userId) {
      handleWebSocketAuth();
    } else if (isSignedIn && userId && !connectionId) {
      // If user is signed in but no connection ID, just redirect to home
      router.replace("/");
    }
  }, [userId, isSignedIn, connectionId, router]);

  // Handle WebSocket authentication
  const handleWebSocketAuth = async () => {
    if (isProcessing) return;

    setIsProcessing(true);
    setMessage("Authenticating with Void editor...");

    try {
      // Send auth data to the WebSocket connection
      const response = await fetch('/api/auth/send-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      });

      if (!response.ok) {
        throw new Error(`Failed to send auth: ${response.status}`);
      }

      const data = await response.json();

      if (data.success) {
        setMessage("Authentication successful! You can now close this window and return to Void.");
      } else {
        setMessage("Failed to authenticate with Void. Please try again.");
      }
    } catch (error) {
      console.error('Error during WebSocket auth:', error);
      setMessage(`Authentication error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Determine where to redirect after auth
  const redirectUrl = connectionId
    ? `/api/auth/callback?connection_id=${connectionId}`
    : '/api/auth/callback';

  // If user is already signed in and we're processing the auth, show a message
  if (isSignedIn && userId && message) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4 bg-gray-50">
        <div className="w-full max-w-md p-8 space-y-8 bg-white rounded-lg shadow-md">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Void Authentication</h1>
            <p className="mt-4 text-gray-600">{message}</p>
            {message.includes("successful") && (
              <p className="mt-4 text-sm text-gray-500">
                You can close this window now.
              </p>
            )}
          </div>
        </div>
      </div>
    );
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