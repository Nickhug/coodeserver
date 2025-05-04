import { NextResponse } from "next/server";

export async function POST() {
  try {
    // Create a response
    const response = NextResponse.json(
      { success: true },
      { status: 200 }
    );
    
    // Clear the auth cookie
    response.cookies.set({
      name: "vvs_auth",
      value: "",
      expires: new Date(0), // Expire immediately
      path: "/"
    });
    
    return response;
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { success: false },
      { status: 500 }
    );
  }
} 