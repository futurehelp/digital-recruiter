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
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

function resolveExecutablePath(): string | undefined {
  // 1) Prefer env var if it exists on the container
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const chosenEnv = firstExisting([envPath]);
  if (chosenEnv) {
    logger.info({ executablePath: chosenEnv }, 'Using PUPPETEER_EXECUTABLE_PATH');
    return chosenEnv;
  }

  // 2) Common Linux paths
  const linux = firstExisting([
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ]);
  if (linux) {
    logger.info({ executablePath: linux }, 'Using system Chromium');
    return linux;
  }

  // 3) Fallback to puppeteer’s bundled chromium if available
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const puppeteer = require('puppeteer');
    if (typeof puppeteer.executablePath === 'function') {
      const bundled: string = puppeteer.executablePath();
      if (bundled && existsSync(bundled)) {
        logger.info({ executablePath: bundled }, 'Using bundled Chromium');
        return bundled;
      }
    }
  } catch {
    // ignore
  }

  logger.warn('No executablePath found; letting Puppeteer choose default.');
  return undefined;
}

export async function getBrowser(): Promise<Browser> {
  if (browser) {
    try {
      await browser.version();
      return browser;
    } catch {
      browser = null;
    }
  }

  const executablePath = resolveExecutablePath();

  const opts: PuppeteerLaunchOptions = {
    headless: env.PUPPETEER_HEADLESS !== 'false',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--window-size=1366,768',
      '--lang=en-US,en',
      '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ],
    defaultViewport: { width: 1366, height: 768 }
  };

  logger.info(
    {
      headless: opts.headless,
      executablePath: executablePath ?? '(auto)'
    },
    'Launching browser…'
  );

  browser = await puppeteerExtra.launch(opts);
  logger.info('Browser launched');
  return browser!;
}

export async function newPage(): Promise<Page> {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setBypassCSP(true);
  return page;
}

export function now() {
  return Date.now();
}

export async function enforceRateLimit() {
  const current = now();
  const elapsed = current - lastRequestTime;
  const delay = Number.isFinite(env.REQUEST_DELAY_MS) ? env.REQUEST_DELAY_MS : 45000;
  if (elapsed < delay) {
    const wait = delay - elapsed;
    logger.info({ waitMs: wait }, 'Rate limiting: waiting…');
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}

process.on('exit', async () => {
  if (browser) {
    await browser.close();
  }
});
