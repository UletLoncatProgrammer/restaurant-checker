FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY sql ./sql
COPY src ./src

EXPOSE 4000

CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]
