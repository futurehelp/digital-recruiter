// src/lib/pageReady.ts
import type { Page } from 'puppeteer';
import { logger } from './logger';

/** Small sleep helper instead of page.waitForTimeout */
function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Click the first element that matches any CSS selector in the list (if present). */
async function clickIfExists(page: Page, selectors: string[], clickDelay = 60) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ delay: clickDelay });
        await sleep(300);
        logger.debug({ sel }, '[pageReady] clicked element by selector');
        return true;
      }
    } catch {
      /* ignore and try next */
    }
  }
  return false;
}

/** Clicks a button-like element whose visible text contains any of textVariants (case-insensitive). */
async function clickByText(page: Page, textVariants: string[], clickDelay = 60) {
  const found = await page.evaluate((variants) => {
    const hay = variants.map((t) => t.toLowerCase());
    const candidates: HTMLElement[] = Array.from(document.querySelectorAll<HTMLElement>(
      // Only common clickable controls - avoids scanning entire DOM
      'button, a, [role="button"]'
    ));

    function visible(el: HTMLElement) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

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
  }, textVariants);

  if (found) {
    await sleep(300 + clickDelay);
    logger.debug({ textVariants }, '[pageReady] clicked element by text');
    return true;
  }
  return false;
}

/** Dismiss likely LinkedIn cookie/consent banners if present. */
export async function killCookieBanners(page: Page) {
  // 1) Try specific selectors first (LinkedIn variants)
  const selectorHit = await clickIfExists(page, [
    'button[aria-label="Accept cookies"]',
    'button[aria-label="Allow all cookies"]',
    'button[data-test-global-alert-action="ACCEPT"]',
    'button[data-test-global-alert-primary-btn]',
    '[data-test-global-alert] button'
  ]);

  if (selectorHit) return;

  // 2) Fallback: try text-based clicks for common variants
  await clickByText(page, [
    'Accept all',
    'Accept cookies',
    'I agree',
    'Allow all',
    'Got it',
    'Agree',
    'Accept'
  ]);
}

/** Gradually scrolls the page to trigger lazy loading. */
export async function autoScroll(page: Page, maxMs = 20_000) {
  const start = Date.now();

  let lastHeight = (await page.evaluate(() => document.body.scrollHeight)) as unknown as number;
  if (!Number.isFinite(lastHeight)) lastHeight = 0;

  while (Date.now() - start < maxMs) {
    await page
      .evaluate(() => {
        window.scrollBy(0, Math.ceil(window.innerHeight * 0.8));
      })
      .catch(() => {});

    await sleep(400 + Math.floor(Math.random() * 300));

    const newHeight = (await page.evaluate(() => document.body.scrollHeight)) as unknown as number;
    const newH = Number.isFinite(newHeight) ? newHeight : lastHeight;
    if (newH <= lastHeight) break;
    lastHeight = newH;
  }

  // Final nudge
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(500);
}

/** Navigation + hydration warmup for LinkedIn content pages. */
export async function warmPageForScrape(page: Page, url: string, label: string) {
  const t0 = Date.now();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => {});
  await page.waitForSelector('body', { timeout: 30_000 }).catch(() => {});

  // Let SPA hydrate a bit
  await sleep(400);

  await killCookieBanners(page);
  await autoScroll(page, 25_000);

  const tookMs = Date.now() - t0;
  logger.debug({ url, tookMs, label }, '[nav] warmPageForScrape done');
}

/** Expand common "Show more" / "See more" buttons to reveal full content. */
export async function expandShowMore(page: Page) {
  // Click any collapsed “Show more” buttons
  const expandedBySelector =
    (await clickIfExists(page, [
      'button[aria-expanded="false"][aria-controls]',
      'button[aria-label*="Show more"]',
      'button[aria-label*="See more"]'
    ])) || false;

  const expandedByText =
    (await clickByText(page, ['Show more', 'See more', 'Show all'])) || false;

  if (expandedBySelector || expandedByText) {
    await sleep(400);
    await autoScroll(page, 4_000);
  }
}
