"use client";

import { UserNav } from "../components/UserNav";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function Home() {
  const searchParams = useSearchParams();
  const authToken = searchParams?.get('auth_token') ?? null;
  const authSuccess = searchParams?.get('auth') === 'success';
  const [tokenProcessed, setTokenProcessed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Handle auth token if present
  useEffect(() => {
    if (authToken && !tokenProcessed) {
      // Token is present in URL - this would be a fallback mechanism
      // In most cases, the token would be sent via WebSocket directly to the VVS app
      setMessage('Authentication successful. You can close this window and return to VVS.');
      setTokenProcessed(true);
    } else if (authSuccess && !tokenProcessed) {
      // WebSocket authentication was successful
      setMessage('Authentication successful. You can close this window and return to VVS.');
      setTokenProcessed(true);
    }
  }, [authToken, authSuccess, tokenProcessed]);

  // Get error message from URL if present
  const errorParam = searchParams?.get('error') ?? null;
  const errorMessage = errorParam ? 
    errorParam === 'auth_failed' ? 'Authentication failed. Please try again.' :
    errorParam === 'no_email' ? 'No email address found. Please ensure your account has an email.' : 
    errorParam === 'server_error' ? 'Server error occurred. Please try again later.' :
    'Authentication error. Please try again.' : null;

  return (
    <main className="flex min-h-screen flex-col items-center p-4 md:p-24">
      <div className="w-full max-w-5xl">
        <header className="flex justify-between items-center mb-8">
          <div>
            <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl">
              VVS
            </h1>
            <p className="text-xl text-muted-foreground">
              Void Editor Management Server
            </p>
          </div>
          
          <UserNav />
        </header>
        
        {/* Auth status messages */}
        {(message || errorMessage) && (
          <div className={`p-4 mb-8 rounded-md ${errorMessage ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`}>
            <p className="font-medium">{message || errorMessage}</p>
          </div>
        )}
        
        <section className="flex flex-col gap-8">
          <div className="prose max-w-none">
            <h2>VVS Authentication Service</h2>
            <p>
              This server handles authentication for VVS (Void Editor). If you were redirected here from VVS,
              the authentication process should complete automatically.
            </p>
            
            <h3>Features</h3>
            <ul>
              <li>Secure authentication with Clerk</li>
              <li>WebSocket-based token transfer</li>
              <li>Fallback token delivery via URL parameters</li>
            </ul>
          </div>

          <div className="flex gap-4 items-center flex-col sm:flex-row">
            <a
              className="rounded-full border border-solid border-black/[.08] dark:border-white/[.145] transition-colors flex items-center justify-center hover:bg-[#f2f2f2] dark:hover:bg-[#1a1a1a] hover:border-transparent font-medium text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 w-full sm:w-auto"
              href="https://voidtools.com/docs"
              target="_blank"
              rel="noopener noreferrer"
            >
              VVS Documentation
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
