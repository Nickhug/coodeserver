FROM node:18-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package.json files for all workspaces
COPY package.json package-lock.json* ./
COPY packages/auth/package.json ./packages/auth/
COPY packages/db/package.json ./packages/db/
COPY packages/logger/package.json ./packages/logger/
COPY packages/types/package.json ./packages/types/
COPY packages/ai-providers/package.json ./packages/ai-providers/
COPY apps/web/package.json ./apps/web/
COPY apps/ws-server/package.json ./apps/ws-server/

# Install dependencies
RUN npm ci --omit=dev

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build argument to specify which app to build
ARG APP_NAME=web

# Build the app
RUN npx turbo run build --filter=${APP_NAME}...

# Production image, copy all files and run
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production

# Don't run as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodeapp
USER nodeapp

# Copy built artifacts based on the app being built
ARG APP_NAME=web

# For Next.js web app
FROM runner as web-runner
WORKDIR /app
COPY --from=builder --chown=nodeapp:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nodeapp:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nodeapp:nodejs /app/apps/web/public ./apps/web/public

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "apps/web/server.js"]

# For WebSocket server
FROM runner as ws-runner
WORKDIR /app
COPY --from=builder --chown=nodeapp:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodeapp:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodeapp:nodejs /app/packages ./packages
COPY --from=builder --chown=nodeapp:nodejs /app/apps/ws-server/dist ./apps/ws-server/dist
COPY --from=builder --chown=nodeapp:nodejs /app/apps/ws-server/package.json ./apps/ws-server/package.json

WORKDIR /app/apps/ws-server
ENV PORT 8080
ENV HOSTNAME "0.0.0.0"

CMD ["node", "dist/index.js"]

# Select the appropriate target based on APP_NAME
FROM ${APP_NAME}-runner 