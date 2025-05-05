import { NextResponse } from 'next/server';
import crypto from 'crypto';

// In-memory store for connections (in a real production app, use Redis or similar)
const connections = new Map<string, { timestamp: number, userId?: string }>();

/**
 * HTTP Fallback endpoint for creating a connection ID when WebSockets fail
 * This provides an alternative authentication path when the WebSocket connection fails
 */
export async function POST() {
  try {
    // Generate a unique connection ID (similar to WebSocket server)
    const connectionId = crypto.randomBytes(16).toString('hex');

    // Store the connection with timestamp
    connections.set(connectionId, {
      timestamp: Date.now(),
      // No userId attached initially - will be set after authentication
    });

    // Clean up old connections (older than 30 minutes)
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    for (const [id, data] of connections.entries()) {
      if (data.timestamp < thirtyMinutesAgo) {
        connections.delete(id);
      }
    }

    // Return the connection ID
    return NextResponse.json({
      success: true,
      connectionId
    });
  } catch (error) {
    console.error('Error creating connection:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create connection' },
      { status: 500 }
    );
  }
}

/**
 * Helper function to check if a connection ID exists (used by other endpoints)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getConnection(connectionId: string) {
  return connections.get(connectionId);
}

/**
 * Helper function to associate a user ID with a connection
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setConnectionUser(connectionId: string, userId: string) {
  const connection = connections.get(connectionId);
  if (connection) {
    connection.userId = userId;
    return true;
  }
  return false;
}
