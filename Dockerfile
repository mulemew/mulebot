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
# This brings data/plugins/healthz.js with it, which is where the bot reads it.

# Run unprivileged. The node image already provides uid 1000 "node".
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
# No NODE_OPTIONS and no MEMORY_PROFILE on purpose. The bot reads the cgroup
# limit at boot and sizes both the V8 heap and its caches from it, so this image
# is correct at any --memory you run it with. Hardcoding a heap size here would
# only be right for one of them.

VOLUME ["/app/data"]
# Plugins live in /app/data/plugins, so that one volume covers them too.

# No HEALTHCHECK, deliberately.
#
# An earlier one probed a hardcoded port 3000, which nothing ever listened on:
# the container was unhealthy from its first check onwards, and a platform that
# restarts unhealthy containers restarted it forever, with nothing in the log to
# explain why. A check that cannot pass is worse than no check.
#
# A Discord bot needs no inbound port at all. Where the platform requires one,
# the bundled healthz plugin binds the injected PORT and reports whether the
# gateway is actually connected. With no PORT it binds nothing.
#
# A platform-level TCP check against PORT then passes. To also have a
# container-level check, uncomment this - it follows PORT rather than assuming:
#
# HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
#   CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/" >/dev/null 2>&1 || exit 1

# No EXPOSE either. It is metadata, but some platforms read it to decide which
# port to route and probe - and naming 3000 when the listener follows the
# injected PORT points them at a port nothing is on.

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
