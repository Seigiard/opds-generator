FROM oven/bun:1-alpine AS base
RUN apk add --no-cache unzip 7zip imagemagick imagemagick-jpeg poppler-utils djvulibre
WORKDIR /app

FROM base AS development
COPY package.json bun.lock* ./
RUN bun install

FROM base AS production
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY static ./static

ENV FILES=/books
ENV DATA=/data
ENV PORT=8080

EXPOSE 8080

VOLUME ["/books", "/data"]

CMD ["bun", "run", "src/index.ts"]
