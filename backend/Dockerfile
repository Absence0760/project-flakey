FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache postgresql-client
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p uploads
EXPOSE 3000
CMD ["sh", "entrypoint.sh"]
