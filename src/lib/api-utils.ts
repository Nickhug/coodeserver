import { NextResponse } from "next/server";

// Define allowed origin for VVS
const ALLOWED_ORIGIN = 'vscode-file://vscode-app';

/**
 * Helper function to create a JSON response with CORS headers
 */
export function createCorsResponse(body: object, status: number = 200) {
  return NextResponse.json(body, {
    status: status,
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Request-Type, X-Request-ID',
    },
  });
}
