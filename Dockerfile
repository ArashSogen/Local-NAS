# =============================================================================
# VaultStage NAS — Production Multi-Stage Dockerfile (Non-Root + Real rclone)
# =============================================================================

# Stage 1: Fetch official static rclone binary
FROM rclone/rclone:1.68 AS rclone-bin

# Stage 2: Build dependencies & frontend bundle
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build tools required for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 3: Minimal production runtime running as non-root user
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install real rclone CLI from official stage
COPY --from=rclone-bin /usr/local/bin/rclone /usr/local/bin/rclone

# Create dedicated non-root user & group
RUN groupadd -g 1001 nas && useradd -u 1001 -g nas -m -s /bin/sh nas

# Copy built application and runtime node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/server ./server
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Prepare writable mount points owned by non-root `nas` user
RUN mkdir -p /data/staging /data/db /data/cloud /config/rclone \
    && chown -R nas:nas /app /data /config

ENV NODE_ENV=production
ENV PORT=3000
ENV HARD_DISK_PATH=/data/staging
ENV DATABASE_URL=/data/db/nas.sqlite
ENV RCLONE_CONFIG_PATH=/config/rclone/rclone.conf
ENV CLOUD_REMOTE=localcloud:/data/cloud

USER nas

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["npx", "tsx", "server.ts"]
