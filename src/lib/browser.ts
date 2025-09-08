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
    // Check if Xvfb is running
    const { stdout } = await execAsync('pgrep -x Xvfb');
    if (stdout.trim()) {
      logger.info('[browser] Xvfb already running');
      return;
    }
  } catch {
    // Xvfb not running, start it
    logger.info('[browser] Starting Xvfb...');
  }
  
  try {
    // Kill any dead Xvfb processes
    await execAsync('pkill -9 Xvfb').catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    
    // Start Xvfb with proper settings
    await execAsync('Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &');
    await new Promise(r => setTimeout(r, 3000));
    
    // Verify it started
    await execAsync('xdpyinfo -display :99');
    logger.info('[browser] Xvfb started successfully on :99');
  } catch (err) {
    logger.error({ err }, '[browser] Failed to start Xvfb');
    throw new Error('Xvfb failed to start. Make sure xvfb is installed: sudo apt-get install xvfb');
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
      logger.info({ executablePath: p }, '[browser] Found Chrome executable');
      return p;
    }
  }
  
  logger.warn('[browser] No Chrome executable found, using bundled');
  return undefined;
}

function ensureDir(p: string) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch { /* ignore */ }
}

function cleanupChromeProfile(userDataDir: string) {
  try {
    // Remove all lock files
    const lockPatterns = [
      'SingletonLock',
      'SingletonCookie', 
      'SingletonSocket',
      '.com.google.Chrome*',
      'chrome_crashpad_handler',
      'lockfile'
    ];
    
    const files = fs.readdirSync(userDataDir);
    for (const file of files) {
      if (lockPatterns.some(pattern => file.includes(pattern.replace('*', '')))) {
        const filePath = path.join(userDataDir, file);
        try {
          fs.unlinkSync(filePath);
          logger.debug({ file: filePath }, '[browser] Removed lock file');
        } catch {}
      }
    }
  } catch (err) {
    logger.debug({ err }, '[browser] Profile cleanup error');
  }
}

/* ───────────────────────── browser lifecycle ───────────────────────── */
async function innerLaunch(): Promise<Browser> {
  const executablePath = resolveExecutablePath();
  
  // Use headful mode as configured
  const headless = !env.HEADFUL;
  
  // Ensure Xvfb is running for headful mode on EC2
  if (!headless) {
    await ensureXvfb();
    process.env.DISPLAY = ':99';
  }
  
  const userDataDir = path.join(os.homedir(), 'chrome-profile-ec2');
  ensureDir(userDataDir);
  cleanupChromeProfile(userDataDir);
  
  // IMPORTANT: Remove --single-process for headful mode - it prevents tab creation!
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    
    // Memory optimization (but not --single-process!)
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI',
    '--disable-features=site-per-process', // Helps with memory
    '--max-old-space-size=512',
    
    // Window settings
    '--window-size=1920,1080',
    '--start-maximized',
    
    // Anti-detection
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    
    // Other optimizations
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-hang-monitor',
    '--disable-sync',
    '--password-store=basic',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-extensions',
    '--metrics-recording-only',
    
    // User data
    `--user-data-dir=${userDataDir}`,
  ];
  
  // Add proxy if configured
  if (env.PROXY_ENABLED && env.PROXY_SERVER) {
    args.push(`--proxy-server=${env.PROXY_SERVER}`);
    if (env.PROXY_BYPASS) {
      args.push(`--proxy-bypass-list=${env.PROXY_BYPASS}`);
    }
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
    // Important: for headful mode
    dumpio: true, // Show browser console for debugging
  };
  
  logger.info({
    headless,
    headful: !headless,
    display: process.env.DISPLAY,
    executablePath: executablePath || 'bundled',
    userDataDir,
    proxy: env.PROXY_ENABLED ? 'enabled' : 'disabled',
  }, '[browser] Launching Chrome (HEADFUL MODE)');
  
  try {
    const b = await puppeteerExtra.launch(opts);
    
    // Test if browser is actually working
    try {
      const testPage = await b.newPage();
      await testPage.goto('about:blank');
      await testPage.close();
      logger.info('[browser] Browser test successful');
    } catch (err) {
      logger.error({ err }, '[browser] Browser test failed');
      throw err;
    }
    
    b.on('disconnected', () => {
      logger.warn('[browser] Browser disconnected');
      browser = null;
    });
    
    const version = await b.version();
    logger.info({ version }, '[browser] Chrome launched successfully');
    
    return b;
  } catch (err) {
    logger.error({ err }, '[browser] Launch failed');
    throw err;
  }
}

async function launchBrowser(): Promise<Browser> {
  let lastError: any;
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        logger.info({ attempt }, '[browser] Retry attempt');
        await new Promise(r => setTimeout(r, 2000));
      }
      
      return await innerLaunch();
    } catch (err: any) {
      lastError = err;
      logger.error({ err, attempt }, '[browser] Launch attempt failed');
      
      // Kill any hanging Chrome processes
      const { exec } = require('child_process');
      await new Promise((resolve) => {
        exec('pkill -9 -f "chrome|chromium"', () => resolve(null));
      });
    }
  }
  
  throw lastError;
}

export async function getBrowser(): Promise<Browser> {
  if (browser) {
    try {
      await browser.version();
      return browser;
    } catch {
      logger.warn('[browser] Cached browser is dead');
      try {
        await browser?.close();
      } catch {}
      browser = null;
    }
  }
  
  browser = await launchBrowser();
  return browser;
}

/* ───────────────────────── Create new page ───────────────────────── */
export async function newPage(): Promise<Page> {
  const b = await getBrowser();
  
  try {
    const page = await b.newPage();
    
    // Set proxy auth if needed
    if (env.PROXY_ENABLED && env.PROXY_USERNAME && env.PROXY_PASSWORD) {
      await page.authenticate({
        username: env.PROXY_USERNAME,
        password: env.PROXY_PASSWORD,
      });
      logger.debug('[browser] Proxy auth set');
    }
    
    // Set timeouts
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(60000);
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Extra headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });
    
    // Anti-detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      
      // @ts-ignore
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
      };
      
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ],
      });
      
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        // @ts-ignore
        window.navigator.permissions.query = (parameters: any) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: 'default' })
            : originalQuery(parameters);
      }
    });
    
    logger.debug('[browser] Page created successfully');
    return page;
    
  } catch (err) {
    logger.error({ err }, '[browser] Failed to create page');
    
    // Browser might be in bad state, kill it
    try {
      await browser?.close();
    } catch {}
    browser = null;
    
    throw err;
  }
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