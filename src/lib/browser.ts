// src/lib/browser.ts
import path from 'path';
import fs, { existsSync } from 'fs';
import os from 'os';
import Bottleneck from 'bottleneck';
import type { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { env } from './env';
import { logger } from './logger';

// Use stealth plugin
puppeteerExtra.use(StealthPlugin());

let browser: Browser | null = null;
let lastRequestTime = 0;

/* ───────────────────────── rate limiter ───────────────────────── */
export const limiter = new Bottleneck({
  minTime: Number.isFinite(env.REQUEST_DELAY_MS) ? env.REQUEST_DELAY_MS : 45_000,
  maxConcurrent: 1,
});

/* ───────────────────────── Ensure Xvfb ───────────────────────── */
async function ensureXvfb(): Promise<void> {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    const { stdout } = await execAsync('pgrep -x Xvfb');
    if (stdout.trim()) {
      logger.info('[browser] Xvfb already running');
      return;
    }
  } catch {
    logger.info('[browser] Starting Xvfb...');
  }
  
  try {
    await execAsync('pkill -9 Xvfb').catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    await execAsync('Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &');
    await new Promise(r => setTimeout(r, 3000));
    logger.info('[browser] Xvfb started on :99');
  } catch (err) {
    logger.error({ err }, '[browser] Failed to start Xvfb');
  }
}

/* ───────────────────────── helpers ───────────────────────── */
function resolveExecutablePath(): string | undefined {
  const paths = [
    env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  
  for (const p of paths) {
    if (p && existsSync(p)) {
      logger.info({ executablePath: p }, '[browser] Found Chrome');
      return p;
    }
  }
  
  return undefined;
}

function ensureDir(p: string) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
}

function cleanupProfile(userDataDir: string) {
  try {
    const files = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const file of files) {
      const p = path.join(userDataDir, file);
      if (existsSync(p)) fs.unlinkSync(p);
    }
  } catch {}
}

/* ───────────────────────── browser lifecycle ───────────────────────── */
async function innerLaunch(): Promise<Browser> {
  const executablePath = resolveExecutablePath();
  const headless = !env.HEADFUL;
  
  if (!headless) {
    await ensureXvfb();
    process.env.DISPLAY = ':99';
  }
  
  const userDataDir = path.join(os.homedir(), 'chrome-profile-ec2');
  ensureDir(userDataDir);
  cleanupProfile(userDataDir);
  
  // Build proxy URL with authentication
  let proxyServer: string | undefined;
  if (env.PROXY_ENABLED && env.PROXY_SERVER) {
    if (env.PROXY_USERNAME && env.PROXY_PASSWORD) {
      // Extract host and port from proxy URL
      const proxyUrl = new URL(env.PROXY_SERVER);
      // Build authenticated proxy URL
      proxyServer = `${proxyUrl.protocol}//${env.PROXY_USERNAME}:${env.PROXY_PASSWORD}@${proxyUrl.host}`;
    } else {
      proxyServer = env.PROXY_SERVER;
    }
  }
  
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    
    // Memory optimization
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI,site-per-process',
    
    // Window
    '--window-size=1920,1080',
    '--start-maximized',
    
    // Anti-detection
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--exclude-switches=enable-automation',
    
    // Other
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-hang-monitor',
    '--password-store=basic',
    '--disable-breakpad',
    '--disable-extensions',
    
    // User data
    `--user-data-dir=${userDataDir}`,
  ];
  
  // Add proxy if configured - WITHOUT auth in URL for Chrome args
  if (env.PROXY_ENABLED && env.PROXY_SERVER) {
    // Chrome doesn't support auth in proxy URL via args
    // We'll use page.authenticate() instead
    args.push(`--proxy-server=${env.PROXY_SERVER}`);
  }
  
  const opts: PuppeteerLaunchOptions = {
    headless,
    executablePath,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    defaultViewport: null,
    timeout: 60000,
    protocolTimeout: 180000,
  };
  
  logger.info({
    headless,
    headful: !headless,
    display: process.env.DISPLAY,
    executablePath: executablePath || 'bundled',
    proxy: proxyServer ? 'configured' : 'none',
  }, '[browser] Launching Chrome');
  
  try {
    const b = await puppeteerExtra.launch(opts);
    
    b.on('disconnected', () => {
      logger.warn('[browser] Disconnected');
      browser = null;
    });
    
    const version = await b.version();
    logger.info({ version }, '[browser] Launched');
    
    return b;
  } catch (err) {
    logger.error({ err }, '[browser] Launch failed');
    throw err;
  }
}

export async function getBrowser(): Promise<Browser> {
  if (browser) {
    try {
      await browser.version();
      return browser;
    } catch {
      logger.warn('[browser] Dead browser, relaunching');
      try { await browser?.close(); } catch {}
      browser = null;
    }
  }
  
  browser = await innerLaunch();
  return browser;
}

/* ───────────────────────── Create page with proxy auth ───────────────────────── */
export async function newPage(): Promise<Page> {
  const b = await getBrowser();
  const page = await b.newPage();
  
  // CRITICAL: Authenticate proxy BEFORE any navigation
  if (env.PROXY_ENABLED && env.PROXY_USERNAME && env.PROXY_PASSWORD) {
    await page.authenticate({
      username: env.PROXY_USERNAME,
      password: env.PROXY_PASSWORD,
    });
    logger.debug('[browser] Proxy authenticated');
  }
  
  // Set timeouts
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);
  
  // Set viewport
  await page.setViewport({ width: 1920, height: 1080 });
  
  // Set user agent - use a real Chrome UA
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
  
  // Set headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
  });
  
  // Anti-detection
  await page.evaluateOnNewDocument(() => {
    // Hide webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    
    // Add chrome
    // @ts-ignore
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
    };
    
    // Mock plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });
    
    // Mock permissions
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      // @ts-ignore
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: 'default' })
          : originalQuery(parameters);
    }
    
    // Override platform
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32'
    });
    
    // Languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });
  });
  
  logger.debug('[browser] Page created');
  return page;
}

/* ───────────────────────── Rate limiting ───────────────────────── */
export async function enforceRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  const delay = env.REQUEST_DELAY_MS || 45000;
  
  if (elapsed < delay) {
    const wait = delay - elapsed;
    logger.info({ waitMs: wait }, '[browser] Rate limiting');
    await new Promise(r => setTimeout(r, wait));
  }
  
  lastRequestTime = Date.now();
}

/* ───────────────────────── Cleanup ───────────────────────── */
export async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
      browser = null;
      logger.info('[browser] Closed');
    } catch (err) {
      logger.error({ err }, '[browser] Close error');
    }
  }
}