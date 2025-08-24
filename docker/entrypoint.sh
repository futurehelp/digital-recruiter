#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] ====== Boot Diagnostics ======"
echo "[entrypoint] Node:        $(node -v || true)"
echo "[entrypoint] NPM:         $(npm -v || true)"
echo "[entrypoint] Chromium bin: $(command -v chromium || echo 'not found')"
echo "[entrypoint] Chromium ver: $(chromium --version || true)"
echo "[entrypoint] HEADFUL:     ${HEADFUL:-false}"
echo "[entrypoint] HEADLESS:    ${PUPPETEER_HEADLESS:-true}"
echo "[entrypoint] DISPLAY:     ${DISPLAY:-'(unset)'}"
echo "[entrypoint] Exec path:   ${PUPPETEER_EXECUTABLE_PATH:-'(unset)'}"
echo "[entrypoint] User data:   ${CHROME_USER_DATA_DIR:-/tmp/chrome-data}"
echo "[entrypoint] PORT:        ${PORT:-3000}"
echo "[entrypoint] ================================="

# Ensure user data dir exists (ephemeral)
mkdir -p "${CHROME_USER_DATA_DIR:-/tmp/chrome-data}"

if [ "${HEADFUL:-false}" = "true" ]; then
  echo "[entrypoint] Starting Xvfb manually (headful mode)…"
  export DISPLAY=":99"
  # start X server in background
  Xvfb "$DISPLAY" -screen 0 1366x768x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
  echo "[entrypoint] Xvfb PID: $XVFB_PID"
  # wait briefly for X to be ready
  for i in $(seq 1 20); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      echo "[entrypoint] Xvfb is up on $DISPLAY"
      break
    fi
    echo "[entrypoint] waiting for Xvfb… ($i/20)"; sleep 0.25
  done
  echo "[entrypoint] Launching Node app (headful)…"
  exec node dist/index.js
else
  echo "[entrypoint] Launching Node app (headless)…"
  exec node dist/index.js
fi
