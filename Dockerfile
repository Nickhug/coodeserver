# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json package-lock.json ./

# Install dependencies (use npm ci for consistency)
RUN npm ci

# Stage 2: Build the application
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dependencies from the previous stage
COPY --from=deps /app/node_modules ./node_modules

# Copy the rest of the application code
COPY . .

# Define build arguments for public environment variables
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
# Add any other NEXT_PUBLIC_ variables needed during build

# Set environment variables for build time from ARGs
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

# Build the Next.js application
RUN npm run build

# Stage 3: Production image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Optionally uncomment the line below and remove the server.ts from the final image
# RUN addgroup --system --gid 1001 nodejs
# RUN adduser --system --uid 1001 nextjs
# USER nextjs

# Copy necessary files from the builder stage using standalone output
COPY --from=builder /app/public ./public
# Copy the standalone server
COPY --from=builder /app/.next/standalone ./ 
# Copy static assets
COPY --from=builder /app/.next/static ./.next/static

# Also copy our custom server and its dependencies (like the websocket lib)
# Standalone output might not include everything from `src` automatically
COPY --from=builder /app/src/server.ts ./src/server.ts
COPY --from=builder /app/src/lib/websocket/server.ts ./src/lib/websocket/server.ts
# Copy any other direct dependencies of server.ts if needed

# Expose the port the app runs on (ensure it matches the standalone server)
EXPOSE 3000

# Define the command to run our custom server using tsx
# Ensure tsx is in production dependencies
CMD ["node", "node_modules/.bin/tsx", "src/server.ts"] 