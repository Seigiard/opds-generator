#!/bin/sh
set -e

BOOKS_DIR="${FILES:-/books}"
DATA_DIR="${DATA:-/data}"
SERVER_URL="http://localhost:${PORT:-8080}"

: <<'LOGIC_EXPLANATION'

# Event-Driven System with EffectTS Queue

### Architecture:
inotifywait → curl POST /events → EffectTS Queue → Handlers

### Events flow:
1. inotifywait outputs JSON events
2. curl sends each event to POST /events
3. Server adds events to bounded Queue (100 capacity)
4. Queue consumer processes events sequentially
5. Handlers are Effect-based with DI for testing

### Event types:
- Books: CREATE, CLOSE_WRITE, DELETE, MOVED_FROM, MOVED_TO
- Data: CLOSE_WRITE, MOVED_TO (entry.xml, _entry.xml only)

LOGIC_EXPLANATION


echo "[init] Running initial sync..."
bun run src/initial-sync.ts

echo "[init] Starting HTTP server with EffectTS queue..."
bun run src/server.ts &
SERVER_PID=$!

# Wait for server to start
echo "[init] Waiting for server to be ready..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s "$SERVER_URL/health" > /dev/null 2>&1; then
    echo "[init] Server is ready"
    break
  fi
  sleep 1
done

echo "[init] Starting /books watcher..."
inotifywait -m -r \
  -e close_write -e delete -e moved_from -e moved_to -e create \
  --format '{"watcher":"books","parent":"%w","name":"%f","events":"%e"}' \
  "$BOOKS_DIR" 2>/dev/null | \
  while read -r line; do
    curl -s -X POST -H "Content-Type: application/json" -d "$line" "$SERVER_URL/events" > /dev/null || true
  done &
BOOKS_WATCHER_PID=$!

echo "[init] Starting /data watcher..."
inotifywait -m -r \
  -e close_write -e moved_to \
  --format '{"watcher":"data","parent":"%w","name":"%f","events":"%e"}' \
  "$DATA_DIR" 2>/dev/null | \
  while read -r line; do
    curl -s -X POST -H "Content-Type: application/json" -d "$line" "$SERVER_URL/events" > /dev/null || true
  done &
DATA_WATCHER_PID=$!

cleanup() {
  echo "[init] Shutting down..."
  kill $SERVER_PID $BOOKS_WATCHER_PID $DATA_WATCHER_PID 2>/dev/null || true
  exit 0
}

trap cleanup SIGTERM SIGINT

echo "[init] All processes started. Waiting..."
wait
