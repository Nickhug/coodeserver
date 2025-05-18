# API Endpoints

## WebSocket Connection Architecture

We've migrated from custom WebSocket proxy implementations to Railway's built-in TCP Proxy feature.

### Current Architecture

- Our WebSocket server runs internally as `ws-server.railway.internal:3001`
- We use Railway's TCP Proxy feature to expose it at `wss://gondola.proxy.rlwy.net:28028`
- Clients connect directly to the Railway TCP Proxy URL

### Benefits

- Simplified codebase - no custom proxy code to maintain
- Better performance with Railway's optimized infrastructure
- Improved reliability with managed proxy services
- Built-in TLS/security handled by Railway

### Client Connection

To connect to the WebSocket from a client application:

```javascript
const socket = new WebSocket('wss://gondola.proxy.rlwy.net:28028');
```

The Void application has been updated to use this endpoint directly.

## Removed Components

The following components have been removed:
- Custom WebSocket proxy implementation (`/api/proxy/ws.ts`)
- WebSocket redirect handler (`/api/ws/[[...path]].ts`)
- HTTP proxy test endpoints (`/api/proxy/direct.ts`) 