#!/bin/sh
# Healthy = the declared minimum is available: Bun reports it (the root feed in DATA, which survives a failed
# verification) and nginx serves that feed. Verification still running is judged by availability, not completion.
# Bun's /status is localhost-only, so this runs inside the container.
BUN_PORT="${PORT:-3000}"

wget -q -O - "http://127.0.0.1:${BUN_PORT}/status" | grep -q '"available":true' \
  && wget -q --spider http://127.0.0.1/_catalog/feed.xml
