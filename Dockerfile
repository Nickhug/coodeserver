# Dockerfile for Next.js app

# 1. Install dependencies only when needed
FROM node:20-alpine AS base

# Install dependencies based on the preferred package manager
# This will also trigger the "prepare" script for next-ws patch
# Do NOT set NODE_ENV=production here, as we need devDependencies for the build stage
WORKDIR /app
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN \
    if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i --frozen-lockfile; \
    else echo "Lockfile not found." && exit 1; \
    fi

# 2. Build the Next.js application
FROM base AS builder
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY next.config.mjs ./
COPY . .

# Explicitly set NODE_PATH to help with alias resolution during build
ENV NODE_PATH=./src

# Set build-time secrets
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-pk_test_cHJlbWl1bS1jYWxmLTQ5LmNsZXJrLmFjY291bnRzLmRldiQ}

# ---- START DIAGNOSTICS ----
RUN echo "--- Checking files before build ---"
RUN ls -la /app
RUN echo "--- Checking src/lib contents ---"
RUN ls -la /app/src/lib
RUN echo "--- Diagnostics End ---"
# ---- END DIAGNOSTICS ----

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
RUN npm run build

# 3. Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

# Set NODE_ENV=production for the final runtime environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED 1

# Set NODE_PATH for runtime as well, especially if using standalone output
ENV NODE_PATH=./

COPY --from=builder /app/public ./public
COPY next.config.mjs ./
COPY tsconfig.json ./

EXPOSE 3000
ENV PORT 3000

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static/

# Dependencies like ws and @clerk/backend should be in package.json and installed during the base stage
# RUN npm install ws@8.18.2 @clerk/backend@1.31.2 --no-save

# Set the correct user for running the application
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs

# Use Next.js CLI to start the application
CMD ["node_modules/.bin/next", "start"]