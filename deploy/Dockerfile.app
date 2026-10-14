# One image = API + the built web app. Build from the REPOSITORY ROOT:
#   docker build -f deploy/Dockerfile.app -t rc-app:$(git rev-parse --short HEAD) .
FROM docker.io/library/node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Empty = the browser version talks to the same address it was loaded from.
ENV VITE_API_URL=""
RUN npm run build

FROM docker.io/library/node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY backend/sql ./sql
COPY backend/src ./src
COPY --from=web /web/dist ./public
RUN chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-4000}/health/ready" || exit 1
# Schema upgrades run on every start (idempotent), then the server.
CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]
