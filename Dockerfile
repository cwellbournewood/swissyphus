# Swissyphus — the AI gateway to Switzerland
#
#   HTTP mode (REST API + remote MCP + OpenAPI):
#     docker run -p 8000:8000 swissyphus/server
#   MCP stdio mode (for MCP clients that spawn a process):
#     docker run -i swissyphus/server --stdio
#   Module filtering works in both modes:
#     docker run -p 8000:8000 swissyphus/server --http --preset business

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE PRIVACY.md ROPA.md BREACH_RESPONSE.md ./
EXPOSE 8000
# API keys + usage persist here; mount a volume to survive restarts:
#   docker run -v swissyphus-data:/app/data -e ADMIN_TOKEN=… -p 8000:8000 swissyphus/server
ENV SWISSYPHUS_DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8000/v1/health || exit 1
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--http"]
