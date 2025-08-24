import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import Bottleneck from 'bottleneck';
import { env } from './env';
import { logger } from './logger';

puppeteer.use(StealthPlugin());

let browser: Browser | null = null;
let lastRequestTime = 0;

export const limiter = new Bottleneck({
  minTime: env.REQUEST_DELAY_MS, // global min delay between jobs
  maxConcurrent: 1
});

export async function getBrowser(): Promise<Browser> {
  if (browser) {
    try {
      await browser.version();
      return browser;
    } catch {
      browser = null;
    }
  }
  logger.info('Launching browser...');
  const opts: PuppeteerLaunchOptions = {
    headless: env.PUPPETEER_HEADLESS !== 'false',
    executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--window-size=1366,768',
      '--lang=en-US,en',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ],
    defaultViewport: { width: 1366, height: 768 }
  };
  browser = await puppeteer.launch(opts);
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
  if (elapsed < env.REQUEST_DELAY_MS) {
    const wait = env.REQUEST_DELAY_MS - elapsed;
    logger.info({ waitMs: wait }, 'Rate limiting: waiting...');
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}

process.on('exit', async () => {
  if (browser) {
    await browser.close();
  }
});
