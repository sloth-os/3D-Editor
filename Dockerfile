# syntax=docker/dockerfile:1.7
#
# Multi-arch image for the 3D editor (PWA + sync/MCP server).
# Build stages run on the build host's native platform; the output is platform independent
# JavaScript, so only the tiny runtime stage is instantiated per target architecture.

ARG NODE_VERSION=22

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
ENV CI=true
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY e2e/package.json e2e/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
COPY apps/server apps/server
ARG APP_VERSION=0.1.0
ENV APP_VERSION=${APP_VERSION}
RUN npm run build -w @3d-editor/web && npm run build -w @3d-editor/server && mkdir -p /out/data

# Production dependencies of the server, exactly as locked (pure JavaScript, so they can be
# installed on the build platform and copied into every target architecture).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY e2e/package.json e2e/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @3d-editor/server --include-workspace-root=false --no-audit --no-fund --ignore-scripts \
 && rm -rf node_modules/@3d-editor

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP_VERSION=0.1.0
LABEL org.opencontainers.image.title="3D Editor" \
      org.opencontainers.image.description="Collaborative, offline-capable web 3D editor with WebDAV storage, real-time sync, MCP control and observability" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.version="${APP_VERSION}"
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PUBLIC_DIR=/app/public \
    DATA_DIR=/data \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
# The runtime stage only copies files (no RUN), so building for arm64/armv7 needs no emulation.
# The server handles SIGTERM/SIGINT itself (graceful shutdown), so no init process is required.
COPY --from=build --chown=node:node /out/data /data
COPY --from=deps --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/apps/server/dist ./
COPY --from=build --chown=node:node /src/apps/web/dist ./public
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "main.js"]
