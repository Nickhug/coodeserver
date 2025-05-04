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

# Set environment variables for build time (if needed)
# ARG NEXT_PUBLIC_...=
# ENV NEXT_PUBLIC_...=$NEXT_PUBLIC_...

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

# Copy necessary files from the builder stage
COPY --from=builder /app/public ./public
COPY --from=builder --chown=1001:1001 /app/.next/standalone ./ 
COPY --from=builder --chown=1001:1001 /app/.next/static ./.next/static

# Copy the custom server file needed to run the application
COPY --from=builder /app/src/server.ts ./src/server.ts
# Copy the WebSocket utility (assuming it's needed by server.ts at runtime)
COPY --from=builder /app/src/lib/websocket/server.ts ./src/lib/websocket/server.ts

# Add tsx for running the TypeScript server file directly
# Ensure tsx and ws are in production dependencies in package.json
COPY --from=builder /app/node_modules/tsx ./node_modules/tsx
COPY --from=builder /app/node_modules/ws ./node_modules/ws
COPY --from=builder /app/node_modules/next ./node_modules/next
# Add any other runtime dependencies needed by server.ts

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the custom server
CMD ["node", "node_modules/.bin/tsx", "src/server.ts"] 