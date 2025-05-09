FROM node:20-alpine AS base

# 1. Install pnpm
RUN npm install -g pnpm

# 2. Set up workspace
WORKDIR /app

# 3. Copy files
# Copy root package.json and lockfile
COPY package.json pnpm-lock.yaml* ./
# Copy turbo.json
COPY turbo.json ./
# Copy entire source code (apps & packages)
COPY . .

# 4. Install dependencies
# Prune devDependencies for production build if needed, or use --prod flag
# RUN pnpm install --prod
RUN pnpm install --frozen-lockfile

# 5. Build applications using turbo
# Adjust filters as necessary based on your turbo.json pipeline config
RUN pnpm turbo run build --filter=web --filter=ws-server

# 6. Final image setup
FROM node:20-alpine AS final

WORKDIR /app

# Copy necessary files from the builder stage
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/apps ./apps
COPY --from=base /app/packages ./packages
COPY --from=base /app/package.json ./

# Expose ports (adjust if your apps use different ports)
EXPOSE 3000
EXPOSE 3001

# Default command to run the web application
# Adjust the filter/script name ('start' assumed) based on your package.json
CMD ["pnpm", "--filter=web", "start"] 