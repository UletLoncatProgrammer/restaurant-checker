FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Reproducible install from the lockfile; no dev dependencies in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY sql ./sql
COPY src ./src

# Run as an unprivileged user, not root.
RUN chown -R node:node /app
USER node

EXPOSE 4000

# Ready only when the database answers too.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-4000}/health/ready" || exit 1

CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]
