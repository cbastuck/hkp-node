FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
# --chown so the unprivileged `node` user (uid 1000, shipped by the base image)
# can read the app without running as root.
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package*.json ./
RUN npm ci --omit=dev
# HOST=0.0.0.0 is required so published ports reach the process. Control external
# exposure on the host instead — e.g. `docker run -p 127.0.0.1:8080:8080` for
# loopback-only — and override with `-e HOST=...` only when you know you need to.
ENV PORT=8080 HOST=0.0.0.0
# Drop root: the server has no need for elevated privileges at runtime.
USER node
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/index.js"]
