FROM node:18-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
COPY apps/ws-server/package.json ./apps/ws-server/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/ai-providers/package.json ./packages/ai-providers/package.json
COPY packages/logger/package.json ./packages/logger/package.json
COPY packages/types/package.json ./packages/types/package.json

RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the project
RUN npm run build --filter=ws-server

# Production image, copy all the files and run the server
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 wsserver
USER wsserver

COPY --from=builder --chown=wsserver:nodejs /app/apps/ws-server/dist/ ./apps/ws-server/dist/
COPY --from=builder --chown=wsserver:nodejs /app/packages/*/dist/ ./packages/*/dist/
COPY --from=builder --chown=wsserver:nodejs /app/package.json ./package.json

# Expose the port the WebSocket server runs on
EXPOSE 3001

# Run the server
CMD ["node", "apps/ws-server/dist/index.js"]
