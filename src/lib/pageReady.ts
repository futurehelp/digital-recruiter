import type { Page } from 'puppeteer';
import { logger } from './logger';

/** Sleep helper */
function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Click the first element matching one of the selectors */
async function clickIfExists(page: Page, selectors: string[], clickDelay = 60) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ delay: clickDelay });
        await sleep(300);
        logger.debug({ sel }, '[pageReady] clicked element');
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

/** Click all buttons/links that contain given text variants */
async function clickAllByText(page: Page, textVariants: string[], maxClicks = 20, clickDelay = 60) {
  const lower = textVariants.map((t) => t.toLowerCase());
  let clicks = 0;

  while (clicks < maxClicks) {
    const clicked = await page.evaluate((variants) => {
      const hay = variants.map((t) => t.toLowerCase());
      const candidates: HTMLElement[] = Array.from(
        document.querySelectorAll<HTMLElement>('button, a, [role="button"]')
      );
      const visible = (el: HTMLElement) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      for (const el of candidates) {
        if (!visible(el)) continue;
        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (!txt) continue;
        for (const needle of hay) {
          if (txt.includes(needle)) {
            el.click();
            return true;
          }
        }
      }
      return false;
    }, lower);

    if (!clicked) break;
    clicks++;
    await sleep(300 + clickDelay);
  }

  if (clicks > 0) logger.debug({ clicks, textVariants }, '[pageReady] clickedAllByText');
  return clicks;
}

/** Kill LinkedIn cookie banners */
export async function killCookieBanners(page: Page) {
  const selectorHit = await clickIfExists(page, [
    'button[aria-label="Accept cookies"]',
    'button[aria-label="Allow all cookies"]',
    'button[data-test-global-alert-action="ACCEPT"]',
    'button[data-test-global-alert-primary-btn]',
    '[data-test-global-alert] button'
  ]);
  if (selectorHit) return;

  await clickAllByText(page, [
    'accept all',
    'accept cookies',
    'i agree',
    'allow all',
    'got it',
    'agree',
    'accept'
  ], 5);
}

/** Scroll entire page for up to 10 minutes */
export async function autoScroll(page: Page, maxMs = 10_000) {
  const start = Date.now();
  let lastHeight = (await page.evaluate(() => document.body.scrollHeight)) as number;
  if (!Number.isFinite(lastHeight)) lastHeight = 0;

  while (Date.now() - start < maxMs) {
    await page.evaluate(() => window.scrollBy(0, Math.ceil(window.innerHeight * 0.9))).catch(() => {});
    await sleep(500);

    const newHeight = (await page.evaluate(() => document.body.scrollHeight)) as number;
    const newH = Number.isFinite(newHeight) ? newHeight : lastHeight;

    if (newH <= lastHeight) break;
    lastHeight = newH;
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(1000);
}

/** Warm up a page: goto, wait, kill banners, scroll */
export async function warmPageForScrape(page: Page, url: string, label: string) {
  const t0 = Date.now();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 600_000 }).catch(() => {});
  await page.waitForSelector('body', { timeout: 600_000 }).catch(() => {});

  await killCookieBanners(page);
  await sleep(1000);
  await autoScroll(page, 600_000);

  const tookMs = Date.now() - t0;
  logger.debug({ url, tookMs, label }, '[nav] warmPageForScrape done');
}

/** Expand all “Show more” / “See more” */
export async function expandShowMore(page: Page) {
  const clicks = await clickAllByText(page, ['show more', 'see more', 'show all'], 20);
  if (clicks > 0) {
    await sleep(1000);
    await autoScroll(page, 20_000);
  }
}
