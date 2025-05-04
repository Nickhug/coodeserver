import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Minimal endpoint to check if user is authenticated 
 * Used by the Void editor to validate session status
 */
export async function GET() {
  try {
    const session = await auth();
    
    if (!session?.userId) {
      return NextResponse.json({ 
        authenticated: false
      });
    }
    
    return NextResponse.json({
      authenticated: true,
      userId: session.userId
    });
  } catch (error) {
    console.error("Session check error:", error);
    return NextResponse.json({ 
      authenticated: false,
      error: "Failed to check authentication status"
    }, { status: 500 });
  }
} 