# Debian bookworm has chromium + xvfb
FROM node:20-bookworm-slim AS deps

# Install Chromium + Xvfb + xauth (needed by xvfb-run) + curl for healthcheck + runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    xauth \
    curl \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libnspr4 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxau6 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# We use system chromium; skip downloading a bundled one
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

# ---- Build
FROM deps AS build
COPY . .
RUN npm run build

# ---- Runtime
FROM deps AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_HEADLESS=true \
    HEADFUL=false \
    CHROME_USER_DATA_DIR=/tmp/chrome-data \
    STARTUP_BROWSER_CHECK=true \
    LOG_LEVEL=info

# Copy built output and re-prune dev deps
COPY --from=build /app/dist /app/dist
COPY --from=build /app/package*.json /app/
RUN npm ci --omit=dev

# Entrypoint script switches to Xvfb if HEADFUL=true, prints diagnostics
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Basic Docker healthcheck hitting our /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
  CMD curl -fsS http://localhost:3000/health || exit 1

EXPOSE 3000
CMD ["/entrypoint.sh"]
