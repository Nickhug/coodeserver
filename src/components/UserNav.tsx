import { UserButton, useUser } from "@clerk/nextjs";
import Link from "next/link";

export function UserNav() {
  const { isSignedIn, user, isLoaded } = useUser();
  
  if (!isLoaded) {
    return (
      <div className="flex items-center gap-4">
        <div className="h-8 w-8 rounded-full bg-gray-200 animate-pulse"></div>
      </div>
    );
  }
  
  if (isSignedIn && user) {
    return (
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-end">
          <span className="text-sm font-medium">{user.firstName || user.emailAddresses[0].emailAddress}</span>
          
          <Link href="/dashboard" className="text-xs text-gray-500 hover:text-blue-600 transition-colors">
            Dashboard
          </Link>
        </div>
        
        <UserButton afterSignOutUrl="/" />
      </div>
    );
  }
  
  return (
    <div className="flex items-center gap-4">
      <Link 
        href="/login"
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
      >
        Sign In
      </Link>
    </div>
  );
} 