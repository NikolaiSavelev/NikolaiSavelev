FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY index.html server.ts standalone.js sw.js icon-192.png icon-512.png ./
COPY crests ./crests
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["bun", "server.ts"]
