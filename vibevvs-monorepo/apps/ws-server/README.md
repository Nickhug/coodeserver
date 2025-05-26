# Void WebSocket Server

This server provides real-time communication between the Void client application and AI providers like Google Gemini, OpenAI, and others.

## Features

- WebSocket-based communication with client applications
- Authentication via Clerk
- Support for multiple AI providers (Gemini, OpenAI, Groq, Mistral)
- Streaming responses from providers
- Automatic connection management and cleanup
- Usage tracking with Supabase

## Setup

### Environment Variables

Create a `.env` file in this directory with the following variables:

```
# Server settings
WS_PORT=3001
WS_HOST=0.0.0.0
WS_PATH=/ws
NODE_ENV=development
PING_INTERVAL=30000

# Authentication
AUTH_ENABLED=true
CLERK_SECRET_KEY=your_clerk_secret_key
CLERK_JWT_KEY=your_clerk_jwt_key

# CORS
CORS_ORIGINS=http://localhost:3000,http://localhost:5173,https://your-app-domain.com

# Default Provider
DEFAULT_PROVIDER=gemini

# AI Provider API Keys
OPENAI_API_KEY=your_openai_api_key
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
MISTRAL_API_KEY=your_mistral_api_key

# Database (Supabase)
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Embedding Configuration
EMBEDDING_MODEL=text-embedding-004
EMBEDDING_API_VERSION=v1alpha
EMBEDDING_BATCH_SIZE=5
EMBEDDING_RATE_LIMIT=5
```

### Installation

This package is part of the Void monorepo. Install dependencies from the root:

```bash
cd ../..
npm install
```

### Running in Development

```bash
npm run dev
```

### Building for Production

```bash
npm run build
```

### Running in Production

```bash
npm run start
```

## WebSocket Protocol

The server uses a structured message protocol defined in the `@repo/types` package.

### Message Types

- Connection: `CONNECT_SUCCESS`, `CONNECT_ERROR`
- Authentication: `AUTHENTICATE`, `AUTH_SUCCESS`, `AUTH_FAILURE`
- Keep-alive: `PING`, `PONG`
- Provider discovery: `PROVIDER_LIST`, `PROVIDER_MODELS`
- Provider interaction: `PROVIDER_REQUEST`, `PROVIDER_RESPONSE`, `PROVIDER_ERROR`
- Streaming: `PROVIDER_STREAM_START`, `PROVIDER_STREAM_CHUNK`, `PROVIDER_STREAM_END`
- Errors: `ERROR`

### Example Client Usage

```typescript
// Connect to WebSocket server
const ws = new WebSocket('ws://localhost:3001/ws');

// Send authentication request
ws.send(JSON.stringify({
  type: 'authenticate',
  payload: {
    token: 'your_clerk_jwt_token'
  }
}));

// Request provider list
ws.send(JSON.stringify({
  type: 'provider_list',
  payload: {}
}));

// Request provider models
ws.send(JSON.stringify({
  type: 'provider_models',
  payload: {
    provider: 'gemini'
  }
}));

// Send a request to a provider
ws.send(JSON.stringify({
  type: 'provider_request',
  payload: {
    provider: 'gemini',
    model: 'gemini-1.5-pro',
    prompt: 'Hello, how are you?',
    temperature: 0.7,
    maxTokens: 1024,
    stream: true
  }
}));

// Handle server messages
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  switch (message.type) {
    case 'provider_stream_chunk':
      console.log('Received chunk:', message.payload.chunk);
      break;
    // Handle other message types
  }
};
```

## Architecture

The WebSocket server is implemented using the high-performance `uWebSockets.js` library. It maintains stateful WebSocket connections with clients and routes requests to appropriate AI providers.

### Key Components

- `server.ts`: Main WebSocket server implementation 
- `config.ts`: Configuration management
- `index.ts`: Server entry point

The server connects to other packages in the monorepo:
- `@repo/auth`: Clerk authentication
- `@repo/ai-providers`: AI provider implementation
- `@repo/types`: WebSocket protocol definitions
- `@repo/logger`: Logging utilities
- `@repo/db`: Database operations 