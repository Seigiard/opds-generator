#!/bin/sh
set -e

BOOKS_DIR="${FILES:-/books}"
DATA_DIR="${DATA:-/data}"
SERVER_URL="${SERVER_URL:-http://localhost:${PORT:-8080}}"

echo "[watcher] Waiting for server to start..."
until curl -s "$SERVER_URL/health" > /dev/null 2>&1; do
  sleep 0.5
done
echo "[watcher] Server is up"

echo "[watcher] Starting /books watcher..."
inotifywait -m -r \
  -e close_write -e delete -e moved_from -e moved_to -e create \
  --format '{"watcher":"books","parent":"%w","name":"%f","events":"%e"}' \
  "$BOOKS_DIR" 2>/dev/null | \
  while read -r line; do
    curl -s -X POST -H "Content-Type: application/json" -d "$line" "$SERVER_URL/events" > /dev/null || true
  done &
BOOKS_WATCHER_PID=$!

echo "[watcher] Starting /data watcher..."
inotifywait -m -r \
  -e close_write -e moved_to \
  --format '{"watcher":"data","parent":"%w","name":"%f","events":"%e"}' \
  "$DATA_DIR" 2>/dev/null | \
  while read -r line; do
    curl -s -X POST -H "Content-Type: application/json" -d "$line" "$SERVER_URL/events" > /dev/null || true
  done &
DATA_WATCHER_PID=$!

cleanup() {
  echo "[watcher] Shutting down..."
  kill $BOOKS_WATCHER_PID $DATA_WATCHER_PID 2>/dev/null || true
  exit 0
}

trap cleanup SIGTERM SIGINT

echo "[watcher] All watchers started. Waiting..."
wait
