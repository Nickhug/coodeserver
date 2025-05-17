# WebSocket Proxy

This directory contains a WebSocket proxy implementation that allows client-side applications to connect to our WebSocket service.

## How it works

1. The client connects to `/api/ws` on our public Next.js application
2. Next.js proxies this connection to our WebSocket service at `coodeai.com/api/ws`
3. Communication flows bidirectionally through this proxy

## Configuration

The proxy is configured with the following environment variable:

- `NEXT_PUBLIC_WS_SERVER_URL`: The URL of the WebSocket server (default: `wss://coodeai.com/api/ws`)

This environment variable is set in the package.json scripts for development, build, and production.

## Client Connection

To connect to the WebSocket from a client, use:

```javascript
// In browser-based clients
const socket = new WebSocket(`${window.location.origin.replace('http', 'ws')}/api/ws`);

// In Void
// The voidWebSocketService has been updated to use this proxy automatically
```

## Troubleshooting

If you encounter connection issues:

1. Check that the Next.js server is running and accessible
2. Verify that the WebSocket service is running properly
3. Look for errors in the Next.js logs
4. Check browser console for connection errors

## Security Considerations

This proxy allows external clients to communicate with our WebSocket service. All authentication and authorization checks are performed by the WebSocket service itself.