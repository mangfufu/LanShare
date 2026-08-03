FROM node:24-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/mangfufu/LanShare"
LABEL org.opencontainers.image.description="LanShare 局域网文件服务器"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./server.js
COPY static ./static
COPY scripts/bootstrap-admin.js ./scripts/bootstrap-admin.js

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
