# Coodeserver - VVS Monorepo

Authentication, subscription management, and AI service proxy for Void Editor, built as a monorepo using Turborepo.

## Features

- Authentication via Clerk
- WebSocket-based communication
- AI provider proxying with streaming support
- Monorepo architecture for modular development

## Monorepo Structure

```
coodeserver/
├── apps/                   # Applications
│   ├── web/                # Next.js web application (authentication portal)
│   └── ws-server/          # WebSocket server for real-time communication
├── packages/               # Shared packages
│   ├── ai-providers/       # AI integration libraries
│   ├── auth/               # Authentication utilities
│   ├── db/                 # Database client and utilities
│   ├── logger/             # Logging infrastructure
│   ├── types/              # Shared TypeScript types
│   ├── config/             # Configuration utilities
│   ├── shared/             # Common utilities
│   └── utils/              # General utility functions
└── turbo.json              # Turborepo configuration
```

## Getting Started

### Prerequisites

1. Node.js 18+ and npm/pnpm
2. A Clerk account (for authentication)

### Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Create a `.env.local` file at the root with the following variables:

```bash
# Clerk Authentication
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_your-key-here
CLERK_SECRET_KEY=sk_test_your-key-here

# Development URLs
NEXT_PUBLIC_WEB_URL=http://localhost:3000
NEXT_PUBLIC_WS_URL=ws://localhost:3001
```

4. Start the development server:

```bash
npm run dev
```

This will start all applications in the monorepo using Turborepo.

## WebSocket Communication

The VVS client communicates with the server using WebSockets for real-time updates and streaming AI responses. The auth flow and communication are handled via WebSocket, providing a secure and efficient way to exchange data.

## Development 

### Adding a new package

1. Create a new directory in the `packages/` folder
2. Initialize a new package with the correct name
3. Add it to the workspace dependencies where needed

### Building

To build all applications and packages:

```bash
npm run build
```

### Testing

To run tests across all packages:

```bash
npm run test
```

## Deployment

The project is configured for deployment using Docker:

```bash
# Build the Docker image
docker build -t coodeserver .

# Run the container
docker run -p 3000:3000 -p 3001:3001 coodeserver
```

You can also deploy individual applications as needed.
