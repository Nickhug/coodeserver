import { NextResponse } from "next/server";

// Handle GET requests to this route by providing WebSocket connection instructions
export async function GET() {
  return NextResponse.json({ 
    message: "This is a WebSocket endpoint. Connect via WebSocket protocol to use it.",
    wsPath: "/api/ws"
  });
}

// Handle OPTIONS for CORS preflight
export async function OPTIONS() {
  return NextResponse.json({}, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}