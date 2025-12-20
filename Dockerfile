FROM oven/bun:1-alpine

RUN apk add --no-cache unzip

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV FILES=/books
ENV DATA=/data
ENV PORT=8080

EXPOSE 8080

VOLUME ["/books", "/data"]

CMD ["bun", "run", "src/index.ts"]
