# ---- Base image with Node + minimal OS deps ----
FROM node:20-slim AS base

# Puppeteer/Chromium dependencies
RUN apt-get update && apt-get install -y \
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
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# ---- Dependencies layer ----
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci --omit=dev

# ---- Build stage ----
FROM base AS build
# Install dev deps for build
RUN npm install -D typescript ts-node-dev @types/node @types/express @types/cors @types/hpp @types/morgan
COPY . .
RUN npm run build

# ---- Runtime image ----
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_HEADLESS=true \
    # Railway ephemeral FS: disable session persistence by default
    DISABLE_SESSION_PERSISTENCE=true

# Copy app code
COPY --from=build /app/dist /app/dist
COPY package*.json ./

# Ensure a clean, production-only node_modules is present
RUN npm ci --omit=dev

# Puppeteer runtime flags (already in code, but env-friendly here)
ENV PUPPETEER_SKIP_DOWNLOAD=false

# Expose port for Railway
EXPOSE 3000

# Start
CMD ["node", "dist/index.js"]