# Swissyphus, the Swiss public-data rollup for AI agents
#
# Published image: ghcr.io/cwellbournewood/swissyphus (see .github/workflows/docker-publish.yml)
#
#   HTTP mode (REST API + remote MCP + OpenAPI):
#     docker run -p 8000:8000 ghcr.io/cwellbournewood/swissyphus
#   MCP stdio mode (for MCP clients that spawn a process):
#     docker run -i ghcr.io/cwellbournewood/swissyphus --stdio
#   Module filtering works in both modes:
#     docker run -p 8000:8000 ghcr.io/cwellbournewood/swissyphus --http --preset business
#
# Behind a reverse proxy (see deploy/), set SWISSYPHUS_TRUST_PROXY=1. Never set
# it when the container port is exposed directly, because clients could then
# spoof X-Forwarded-For.

FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:25-alpine
# Lets the official MCP Registry verify that this image belongs to server.json's name.
LABEL io.modelcontextprotocol.server.name="io.github.cwellbournewood/swissyphus"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE PRIVACY.md ROPA.md BREACH_RESPONSE.md ./
EXPOSE 8000
# API keys + usage persist here; mount a volume to survive restarts:
#   docker run -v swissyphus-data:/app/data -e ADMIN_TOKEN=… -p 8000:8000 ghcr.io/cwellbournewood/swissyphus
ENV SWISSYPHUS_DATA_DIR=/app/data
# Last-known-good copies of upstream responses, so a source outage right after a
# restart still gets (clearly marked) stale data instead of errors. See src/core/lkg.ts.
ENV SWISSYPHUS_LKG_DIR=/app/data/lkg
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8000/v1/health || exit 1
# The server handles SIGTERM gracefully (drains, flushes keys.json, exits 0).
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--http"]
