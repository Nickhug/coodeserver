FROM node:18-alpine AS base

ARG NEXT_PUBLIC_APP_URL
ARG NODE_ENV
ARG PORT
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG SUPABASE_SERVICE_ROLE_KEY
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG CLERK_SECRET_KEY
ARG CLERK_WEBHOOK_SECRET
ARG STRIPE_SECRET_KEY
ARG STRIPE_WEBHOOK_SECRET
ARG STRIPE_BASIC_PRICE_ID
ARG STRIPE_PRO_PRICE_ID
ARG STRIPE_ENTERPRISE_PRICE_ID
ARG OPENAI_API_KEY
ARG ANTHROPIC_API_KEY
ARG GROQ_API_KEY
ARG MISTRAL_API_KEY
ARG GOOGLE_API_KEY
ARG GEMINI_API_KEY
ARG XAI_API_KEY
ARG NEXT_PUBLIC_WEBSOCKET_URL
ARG NEXT_PUBLIC_WS_SERVER_URL
ARG WS_PORT

ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NODE_ENV=${NODE_ENV:-production}
ENV PORT=${PORT:-3000}
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
ENV SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
ENV CLERK_SECRET_KEY=${CLERK_SECRET_KEY}
ENV CLERK_WEBHOOK_SECRET=${CLERK_WEBHOOK_SECRET}
ENV STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
ENV STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
ENV STRIPE_BASIC_PRICE_ID=${STRIPE_BASIC_PRICE_ID}
ENV STRIPE_PRO_PRICE_ID=${STRIPE_PRO_PRICE_ID}
ENV STRIPE_ENTERPRISE_PRICE_ID=${STRIPE_ENTERPRISE_PRICE_ID}
ENV OPENAI_API_KEY=${OPENAI_API_KEY}
ENV ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
ENV GROQ_API_KEY=${GROQ_API_KEY}
ENV MISTRAL_API_KEY=${MISTRAL_API_KEY}
ENV GOOGLE_API_KEY=${GOOGLE_API_KEY}
ENV GEMINI_API_KEY=${GEMINI_API_KEY}
ENV XAI_API_KEY=${XAI_API_KEY}
ENV NEXT_PUBLIC_WEBSOCKET_URL=${NEXT_PUBLIC_WEBSOCKET_URL}
ENV NEXT_PUBLIC_WS_SERVER_URL=${NEXT_PUBLIC_WS_SERVER_URL}
ENV WS_PORT=${WS_PORT:-8080}

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/auth/package.json ./packages/auth/
COPY packages/db/package.json ./packages/db/
COPY packages/logger/package.json ./packages/logger/
COPY packages/types/package.json ./packages/types/
COPY packages/ai-providers/package.json ./packages/ai-providers/
COPY apps/web/package.json ./apps/web/
COPY apps/ws-server/package.json ./apps/ws-server/

RUN npm ci --omit=dev

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG APP_NAME
RUN echo "Building app: $APP_NAME"

RUN npm run build --workspace=apps/$APP_NAME

FROM base AS runner
WORKDIR /app

ENV NODE_ENV production

COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/node_modules /app/node_modules/

COPY --from=builder /app/apps/web/.next /app/apps/web/.next/
COPY --from=builder /app/apps/web/public /app/apps/web/public/
COPY --from=builder /app/apps/web/package.json /app/apps/web/package.json

COPY --from=builder /app/packages/ /app/packages/
COPY --from=builder /app/apps/ws-server/dist /app/apps/ws-server/dist/
COPY --from=builder /app/apps/ws-server/package.json /app/apps/ws-server/package.json

EXPOSE 3000
EXPOSE 8080

CMD if [ "$APP_NAME" = "web" ]; then \
      cd apps/web && npm start; \
    elif [ "$APP_NAME" = "ws-server" ]; then \
      cd apps/ws-server && node dist/index.js; \
    else \
      echo "Error: APP_NAME not set or invalid - got $APP_NAME" && exit 1; \
    fi 