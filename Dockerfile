FROM oven/bun:1-alpine AS base
RUN apk add --no-cache unzip 7zip poppler-utils djvulibre inotify-tools nginx openssl util-linux \
    && addgroup nginx bun
WORKDIR /app

FROM base AS development
COPY package.json bun.lock* ./
COPY vendor ./vendor
RUN bun install

FROM base AS production
COPY package.json bun.lock* ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY static ./static
COPY nginx.conf.template /app/nginx.conf.template
COPY entrypoint.sh /app/entrypoint.sh
COPY healthcheck.sh /app/healthcheck.sh
RUN chmod +x /app/entrypoint.sh /app/healthcheck.sh

ENV FILES=/books
ENV DATA=/data
ENV PORT=3000

# nginx listens on port 80
EXPOSE 80

VOLUME ["/books", "/data"]

# Healthy means the root feed and root page are available (see healthcheck.sh), not that verification finished.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
  CMD ["/bin/sh", "/app/healthcheck.sh"]

ENTRYPOINT []
CMD ["/bin/sh", "/app/entrypoint.sh"]
