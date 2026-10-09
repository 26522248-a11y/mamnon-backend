# Next.js frontend (/workspace/mamnon-web). Build context = the mamnon-web folder (see docker-compose.yml).
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Same-origin deployment: browser calls https://<domain>/api/v1 (Caddy routes /api/* to the API).
# Empty string => relative "/api/v1" (src/lib/api.ts uses NEXT_PUBLIC_API_URL ?? "http://localhost:3001").
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev && mkdir -p public

FROM node:20-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=Asia/Ho_Chi_Minh PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.mjs ./
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
