#!/bin/sh
# Healthy = the declared minimum is available: Bun reports it (a root feed and root page in DATA, which survives a
# failed verification) and nginx serves both. A feed without its page, or verification still running, is judged by
# availability, not completion. Bun's /status is localhost-only, so this runs inside the container.
BUN_PORT="${PORT:-3000}"

wget -q -O - "http://127.0.0.1:${BUN_PORT}/status" | grep -q '"available":true' \
  && wget -q --spider http://127.0.0.1/feed.xml \
  && wget -q --spider http://127.0.0.1/index.html
