#!/bin/sh
set -e

BOOKS_DIR="${FILES:-/books}"
DATA_DIR="${DATA:-/data}"

: <<'LOGIC_EXPLANATION'

# Event Driver System watches files and trigger related events

### Watchers:
- ${BOOKS_DIR}/${FOLDER} renamed → FolderSync script
- ${BOOKS_DIR}/${FOLDER} changed (means something changed directly inside this folder, 1 level deep) → folder sync script
- ${BOOKS_DIR}/${FOLDER} removed → FolderCleanup script

- ${BOOKS_DIR}/${BOOK} added/renamed/changed → BookSync script
- ${BOOKS_DIR}/${BOOK} removed → BookCleanup script

- ${DATA_DIR}/**/*/_entry.xml changed → FolderMetadataSync and ParentFolderMetadataSync script
- ${DATA_DIR}/**/*/entry.xml changed → ParentFolderMetadataSync script

Note: Rename in inotify = MOVED_FROM (old path) + MOVED_TO (new path)

### Scripts

#### FolderSync script
Generate new folder's `_entry.xml` in data/$FOLDER_PATH/

#### FolderCleanup script
Remove data/$FOLDER_PATH

#### BookSync script
Generate new book's data (`entry.xml`, `cover.jpg`, `thumb.jpg`) in data/$BOOK_PATH/

#### BookCleanup script
Remove data/$BOOK_PATH/

#### FolderMetadataSync
Regenerate `feed.xml` in this directory, update _entry.xml with bookCount

#### ParentFolderMetadataSync
Regenerate `feed.xml` in parent's directory

LOGIC_EXPLANATION


echo "[init] Running initial sync..."
bun run src/initial-sync.ts

echo "[init] Starting HTTP server..."
bun run src/server.ts &
SERVER_PID=$!

echo "[init] Starting /books watcher..."
inotifywait -m -r \
  -e close_write -e delete -e moved_from -e moved_to -e create \
  --format '%w|%f|%e' "$BOOKS_DIR" 2>/dev/null | \
  bun run src/event/debouncer.ts books &
BOOKS_WATCHER_PID=$!

echo "[init] Starting /data watcher..."
inotifywait -m -r \
  -e close_write -e moved_to \
  --format '%w|%f|%e' "$DATA_DIR" 2>/dev/null | \
  bun run src/event/debouncer.ts data &
DATA_WATCHER_PID=$!

cleanup() {
  echo "[init] Shutting down..."
  kill $SERVER_PID $BOOKS_WATCHER_PID $DATA_WATCHER_PID 2>/dev/null || true
  exit 0
}

trap cleanup SIGTERM SIGINT

echo "[init] All processes started. Waiting..."
wait
