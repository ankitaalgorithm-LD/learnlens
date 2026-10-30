# LearnLens: one container serving the dashboard, the admin API and the tracking endpoints.

# 1. Build the dashboard
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2. Run the server
FROM node:22-alpine
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY server/ server/
COPY sdk/ sdk/
COPY examples/ examples/
COPY --from=web /app/web/dist web/dist
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "server/src/index.js"]
