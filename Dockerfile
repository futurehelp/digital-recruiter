# Use Debian bookworm so the chromium package is available
FROM node:20-bookworm-slim AS deps

# System deps for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
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

# Avoid downloading bundled Chromium (we use system package)
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM deps AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_HEADLESS=true \
    # point Puppeteer at system Chromium
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy built artifacts and prod node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/package*.json /app/
# ensure prod deps only (in case dev snuck in)
RUN npm ci --omit=dev

EXPOSE 3000
CMD ["node", "dist/index.js"]
