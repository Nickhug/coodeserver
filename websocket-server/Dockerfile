# Dockerfile for Standalone WebSocket Server

# Use a suitable Node.js base image
FROM node:20-alpine AS base

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
# Install only production dependencies for the final image
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Build TypeScript code
RUN npm run build

# Expose the port the server will listen on (defined in server.ts or ENV)
EXPOSE 3001

# Command to run the server
CMD [ "node", "dist/server.js" ]
