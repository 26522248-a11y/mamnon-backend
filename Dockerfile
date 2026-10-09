# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Ho_Chi_Minh PORT=3001 UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY assets ./assets
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Never seeds. Migrations are a separate one-shot command (see deploy/docker-compose.yml: service "migrate").
CMD ["node", "dist/main.js"]
