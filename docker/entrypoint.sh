#!/usr/bin/env bash
set -euo pipefail

# Ensure user data dir exists (ephemeral)
mkdir -p "${CHROME_USER_DATA_DIR:-/tmp/chrome-data}"

if [ "${HEADFUL:-false}" = "true" ]; then
  echo "[entrypoint] Starting app in HEADFUL mode with Xvfb…"
  # 1366x768x24 virtual screen
  exec xvfb-run -a --server-args="-screen 0 1366x768x24" node dist/index.js
else
  echo "[entrypoint] Starting app in HEADLESS mode…"
  exec node dist/index.js
fi
