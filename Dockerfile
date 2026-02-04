# Сборка (better-sqlite3 — нативный модуль, нужны инструменты сборки)
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --production

# Продакшен-образ
FROM node:20-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
ENV DB_PATH=/data/talks.db

EXPOSE 0

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
