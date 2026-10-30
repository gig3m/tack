# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN npx vite build

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=3000 \
    TACK_DATA_DIR=/data \
    TACK_STATIC_DIR=/app/dist
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.ts"]
