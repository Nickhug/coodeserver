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

# Hardcoded environment variables for build time
ENV NEXT_PUBLIC_APP_URL=https://coodeserver.fly.dev
ENV NEXT_PUBLIC_SUPABASE_URL=https://qmdvhigkmahvadrwqrxv.supabase.co
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFtZHZoaWdrbWFodmFkcndxcnh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDYzMzgzMzYsImV4cCI6MjA2MTkxNDMzNn0.NFExNXQidZfe4hxYvmWb_2ZcUGU4OjPHOfY9p2XZods
ENV SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFtZHZoaWdrbWFodmFkcndxcnh2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjMzODMzNiwiZXhwIjoyMDYxOTE0MzM2fQ.c9tXy2ZbcoJ8xu6qtwYf-BGCLtbEREN2XnEuQhB3HYs
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_cHJlbWl1bS1jYWxmLTQ5LmNsZXJrLmFjY291bnRzLmRldiQ
ENV CLERK_SECRET_KEY=sk_test_3U48NEC0fMGXnd8DnqtVbl7AZAfvZnlFdb9SnvaTIT
ENV CLERK_WEBHOOK_SECRET=
ENV STRIPE_SECRET_KEY=123
ENV STRIPE_WEBHOOK_SECRET=1234
ENV STRIPE_BASIC_PRICE_ID=1245
ENV STRIPE_PRO_PRICE_ID=12534
ENV STRIPE_ENTERPRISE_PRICE_ID=1241234

# Build the Next.js application
RUN npm run build

# Stage 3: Production image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Hardcoded environment variables for runtime
ENV NEXT_PUBLIC_APP_URL=https://coodeserver.fly.dev
ENV NEXT_PUBLIC_SUPABASE_URL=https://qmdvhigkmahvadrwqrxv.supabase.co
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFtZHZoaWdrbWFodmFkcndxcnh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDYzMzgzMzYsImV4cCI6MjA2MTkxNDMzNn0.NFExNXQidZfe4hxYvmWb_2ZcUGU4OjPHOfY9p2XZods
ENV SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFtZHZoaWdrbWFodmFkcndxcnh2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjMzODMzNiwiZXhwIjoyMDYxOTE0MzM2fQ.c9tXy2ZbcoJ8xu6qtwYf-BGCLtbEREN2XnEuQhB3HYs
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_cHJlbWl1bS1jYWxmLTQ5LmNsZXJrLmFjY291bnRzLmRldiQ
ENV CLERK_SECRET_KEY=sk_test_3U48NEC0fMGXnd8DnqtVbl7AZAfvZnlFdb9SnvaTIT
ENV CLERK_WEBHOOK_SECRET=
ENV STRIPE_SECRET_KEY=123
ENV STRIPE_WEBHOOK_SECRET=1234
ENV STRIPE_BASIC_PRICE_ID=1245
ENV STRIPE_PRO_PRICE_ID=12534
ENV STRIPE_ENTERPRISE_PRICE_ID=1241234

# Copy necessary files from the builder stage using standalone output
COPY --from=builder /app/public ./public
# Copy the standalone server
COPY --from=builder /app/.next/standalone ./ 
# Copy static assets
COPY --from=builder /app/.next/static ./.next/static

# Expose the port the app runs on
EXPOSE 3000

# Use the standalone Next.js server directly
CMD ["node", "server.js"] 