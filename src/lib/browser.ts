import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import Bottleneck from 'bottleneck';
import { existsSync } from 'fs';
import { env } from './env';
import { logger } from './logger';

puppeteerExtra.use(StealthPlugin());

let browser: Browser | null = null;
let lastRequestTime = 0;

export const limiter = new Bottleneck({
  minTime: Number.isFinite(env.REQUEST_DELAY_MS) ? env.REQUEST_DELAY_MS : 45000,
  maxConcurrent: 1
});

function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const p of paths) if (p && existsSync(p)) return p;
  return undefined;
}

function resolveExecutablePath(): string | undefined {
  const envPath = env.PUPPETEER_EXECUTABLE_PATH;
  const chosenEnv = firstExisting([envPath]);
  if (chosenEnv) {
    logger.info({ executablePath: chosenEnv }, '[browser] using PUPPETEER_EXECUTABLE_PATH');
    return chosenEnv;
  }
  const linux = firstExisting([
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ]);
  if (linux) {
    logger.info({ executablePath: linux }, '[browser] using system Chromium');
    return linux;
  }
  try {
    const puppeteer = require('puppeteer');
    if (typeof puppeteer.executablePath === 'function') {
      const bundled: string = puppeteer.executablePath();
      if (bundled && existsSync(bundled)) {
        logger.info({ executablePath: bundled }, '[browser] using bundled Chromium');
        return bundled;
      }
    }
  } catch (err) {
    logger.warn({ err }, '[browser] failed to resolve bundled chromium');
  }
  logger.warn('[browser] no executablePath found; letting Puppeteer choose default');
  return undefined;
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = resolveExecutablePath();

  // ✅ FIX: env.HEADFUL and env.PUPPETEER_HEADLESS are already booleans
  const headless = env.HEADFUL ? false : env.PUPPETEER_HEADLESS;

  const args = [
    `--user-data-dir=${env.CHROME_USER_DATA_DIR}`,
    '--profile-directory=Default',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-web-security',
    '--window-size=1366,768',
    '--lang=en-US,en',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--password-store=basic',
    '--enable-features=NetworkService,NetworkServiceInProcess'
  ];

  const opts: PuppeteerLaunchOptions = {
    headless,
    executablePath,
    args,
    defaultViewport: { width: 1366, height: 768 }
  };

  logger.info({ headless, executablePath: executablePath ?? '(auto)', args }, '[browser] launching…');
  const b = await puppeteerExtra.launch(opts);

  b.on('disconnected', async () => {
    logger.warn('[browser] disconnected — will relaunch on next request');
    browser = null;
  });

  const version = await b.version().catch(() => 'unknown');
  logger.info({ version }, '[browser] launched');

  return b;
}

export async function getBrowser(): Promise<Browser> {
  if (browser) {
    try {
      await browser.version(); // throws if dead
      return browser;
    } catch (err) {
      logger.warn({ err }, '[browser] cached instance unhealthy; relaunching');
      browser = null;
    }
  }
  browser = await launchBrowser();
  return browser!;
}

export async function newPage(): Promise<Page> {
  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setBypassCSP(true);
    logger.debug('[browser] new page created');
    return page;
  } catch (err) {
    // One-shot retry: relaunch & try again
    logger.warn({ err }, '[browser] newPage() failed — relaunching and retrying once');
    try {
      browser?.removeAllListeners?.();
      await browser?.close?.();
    } catch { /* ignore */ }
    browser = null;
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setBypassCSP(true);
    logger.debug('[browser] new page created after relaunch');
    return page;
  }
}

export async function enforceRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  const delay = Number.isFinite(env.REQUEST_DELAY_MS) ? env.REQUEST_DELAY_MS : 45000;
  if (elapsed < delay) {
    const wait = delay - elapsed;
    logger.info({ waitMs: wait }, '[browser] rate limiting: waiting…');
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}
