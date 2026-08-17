# Small-host image. Final size is roughly 60 MB plus 27 MB of node_modules.
#
#   docker build -t discord-bot .
#   docker run -d --name bot --memory=256m --restart=unless-stopped \
#     -e DISCORD_TOKEN=xxx -v bot-data:/app/data discord-bot
#
# --memory=256m is read by the bot through the cgroup, so it picks its "low"
# cache profile without being told.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev keeps the image to the single runtime dependency.
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app

# wget is used by the healthcheck below and ships with busybox already.
# tini reaps zombies and forwards SIGTERM, which is what lets the bot flush its
# stores and release plugin-held ports on shutdown.
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Run unprivileged. The node image already provides uid 1000 "node".
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
# Cap the V8 heap. Without this, V8 sizes its heap from HOST memory even inside
# a 256 MB container, never collects under pressure, and the container is
# OOM-killed with no stack trace. Roughly 55% of --memory.
ENV NODE_OPTIONS=--max-old-space-size=140
# Leave MEMORY_PROFILE unset: the bot reads the cgroup limit and decides.

VOLUME ["/app/data"]

# Uses the bundled httpserver plugin. Drop this if you disable that plugin.
# /health returns 503 until the gateway connects, which is exactly the
# behaviour a healthcheck wants during startup.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
