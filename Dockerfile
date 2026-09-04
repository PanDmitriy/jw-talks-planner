FROM node:18-alpine AS builder
WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# Если боту для работы нужны статичные файлы или папки (например, docs), раскомментируйте строку ниже:
# COPY --from=builder /app/docs ./docs

CMD ["npm", "start"]
