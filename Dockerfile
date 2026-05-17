FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/index.js"]
