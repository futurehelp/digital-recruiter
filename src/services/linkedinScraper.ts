// src/services/linkedinScraper.ts
import type { Page } from 'puppeteer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enforceRateLimit, newPage, limiter } from '../lib/browser';
import { LinkedInProfile } from '../types';
import { loadSession, saveSession } from '../lib/session';
import { warmPageForScrape, expandShowMore, killCookieBanners } from '../lib/pageReady';

// ---------- small utils ----------
const SLOW_MS = env.ELEMENT_TIMEOUT_MS ?? 45_000;
const PAGE_MS = env.PAGE_TIMEOUT_MS ?? 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const human = (min = 250, max = 700) => sleep(Math.floor(min + Math.random() * (max - min)));

function clean(t?: string | null) {
  return (t || '').replace(/\s+/g, ' ').trim();
}

async function safeGoto(page: Page, url: string, label: string) {
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_MS });
  } catch (err) {
    logger.warn({ err, url }, '[nav] goto error; continuing');
  } finally {
    logger.debug({ url, tookMs: Date.now() - t0, label }, '[nav] safeGoto settled');
  }
}

async function debugDump(page: Page, tag: string) {
  try {
    const ts = Date.now();
    const png = `/home/ubuntu/debug-${tag}-${ts}.png`;
    const html = `/home/ubuntu/debug-${tag}-${ts}.html`;
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    const content = await page.content().catch(() => '');
    if (content) {
      const fs = await import('fs');
      fs.writeFileSync(html, content);
    }
    logger.info({ pngPath: png, htmlPath: html }, '[debugDump] wrote ' + tag);
  } catch (err) {
    logger.error({ err }, '[debugDump] failed for ' + tag);
  }
}

// ---------- auth ----------
export async function authenticateLinkedIn(): Promise<Page> {
  const page = await newPage();

  // Try saved session first
  try {
    const loaded = await loadSession(page);
    if (loaded) {
      await safeGoto(page, 'https://www.linkedin.com/feed/', 'session-check');
      const url = page.url();
      logger.info({ url }, '[li] session check /feed');
      if (!/\/login|\/checkpoint|\/challenge/.test(url)) {
        logger.info('[li] ✅ Authenticated via saved session');
        return page;
      }
      logger.warn('[li] saved session invalid, need fresh login');
    }
  } catch (err) {
    logger.warn({ err }, '[li] no valid session; will fresh login');
  }

  // Fresh login
  if (!env.LINKEDIN_EMAIL || !env.LINKEDIN_PASSWORD) {
    throw new Error('Missing LINKEDIN_EMAIL / LINKEDIN_PASSWORD env vars');
  }

  await safeGoto(page, 'https://www.linkedin.com/login', 'login-page');
  await debugDump(page, 'login-page');

  await page.waitForSelector('#username', { timeout: SLOW_MS }).catch(() => {});
  await human(); await page.type('#username', env.LINKEDIN_EMAIL, { delay: 70 });
  await human(); await page.type('#password', env.LINKEDIN_PASSWORD, { delay: 70 });
  await human(200, 500);

  logger.debug('[li] submitting form');
  await Promise.allSettled([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: PAGE_MS }).catch(() => {})
  ]);

  await debugDump(page, 'after-submit');

  const currentUrl = page.url();
  if (/\/checkpoint|\/challenge/.test(currentUrl)) {
    logger.warn('[li] checkpoint/challenge detected');
    await debugDump(page, 'checkpoint');
  }
  logger.info({ currentUrl }, '[li] post-login URL');

  // Save new session regardless (it still works for subsequent page loads)
  await saveSession(page);

  return page;
}

// ---------- scraping helpers ----------
/** Robust experience extractor for the /details/experience page. */
async function extractExperienceFromDetails(page: Page) {
  // Page has already been warmed & scrolled; still wait briefly for list items
  await page.waitForSelector('li.pvs-list__paged-list-item', { timeout: SLOW_MS }).catch(() => {});
  await killCookieBanners(page);

  const items = await page.evaluate(() => {
    const clean = (t?: string | null) => (t || '').replace(/\s+/g, ' ').trim();

    function pick(el: Element, selectors: string[]): string {
      for (const s of selectors) {
        const n = el.querySelector<HTMLElement>(s);
        if (n) {
          const txt = clean(n.innerText || n.textContent || '');
          if (txt) return txt;
        }
      }
      return '';
    }

    function hasTimeDescendant(span: Element): boolean {
      if (!span) return false;
      return !!span.querySelector('time');
    }

    function heuristicLines(container: Element): string[] {
      const spans = Array.from(container.querySelectorAll('span'))
        .map((s) => clean((s as HTMLElement).innerText || s.textContent || ''))
        .filter(Boolean);
      return Array.from(new Set(spans)).slice(0, 8);
    }

    function firstSpanWithTimeText(el: Element): string {
      const spans = Array.from(el.querySelectorAll('span'));
      for (const span of spans) {
        if (hasTimeDescendant(span)) {
          const t = clean((span as HTMLElement).innerText || span.textContent || '');
          if (t) return t;
        }
      }
      return '';
    }

    return Array.from(document.querySelectorAll('li.pvs-list__paged-list-item')).map((li) => {
      const main =
        li.querySelector<HTMLElement>('div.display-flex.flex-column.align-self-center.flex-grow-1') ||
        li.querySelector<HTMLElement>('div.pvs-entity') ||
        li;

      // Position
      const position =
        pick(main, [
          '.mr1.hoverable-link-text.t-bold span',
          '.t-bold',
          'a[aria-hidden="true"] span'
        ]) || heuristicLines(main)[0] || '';

      // Company
      const company =
        pick(main, [
          '.t-14.t-normal',
          '.pv-entity__secondary-title',
          'a[href*="/company/"] span[aria-hidden="true"]'
        ]) || heuristicLines(main)[1] || '';

      // Duration / dates: try explicit time spans, else heuristic line containing date-ish text
      const duration =
        firstSpanWithTimeText(main) ||
        (heuristicLines(main).find((t) => /·|month|year|present|20\d{2}/i.test(t)) || '');

      const description =
        pick(li, [
          '.inline-show-more-text',
          '.pv-shared-text-with-see-more',
          '[data-test-description]'
        ]);

      return { position, company, duration, description };
    }).filter((x) => x.position || x.company);
  });

  return items as Array<{
    position: string;
    company: string;
    duration: string;
    description: string;
  }>;
}

async function extractBasicsFromMain(page: Page) {
  await killCookieBanners(page);
  await page.waitForSelector('.pv-text-details__left-panel, .mt2, h1', { timeout: SLOW_MS }).catch(() => {});
  return await page.evaluate(() => {
    const clean = (t?: string | null) => (t || '').replace(/\s+/g, ' ').trim();
    const name =
      clean(document.querySelector('.text-heading-xlarge, h1')?.textContent) ||
      clean(document.querySelector('h1')?.textContent);
    const title = clean(document.querySelector('.text-body-medium.break-words')?.textContent);
    const locNode =
      document.querySelector('.text-body-small.inline') ||
      document.querySelector('[data-test-location]');
    const location = clean(locNode?.textContent);
    return { name, title, location, summary: '' };
  });
}

// ---------- main scrape ----------
export async function scrapeLinkedInProfile(profileUrl: string): Promise<any> {
  await enforceRateLimit();

  let page: Page | null = null;

  try {
    logger.info({ profileUrl }, '[li] begin scrape');
    page = await authenticateLinkedIn();

    // DETAILS page (experience) — use warmup + expand for reliability on EC2
    const detailsUrl = `${profileUrl.replace(/\/$/, '')}/details/experience/`;
    logger.info({ detailsUrl }, '[li] goto details/experience page');
    await warmPageForScrape(page, detailsUrl, 'details-experience');
    await expandShowMore(page);
    await debugDump(page, 'after-details');

    const workHistory = await extractExperienceFromDetails(page).catch(() => []);
    await human(500, 1000);

    // MAIN profile (basics)
    logger.info('[li] back to main profile for summary');
    await warmPageForScrape(page, profileUrl, 'main-profile');
    await debugDump(page, 'after-main');

    const basics = await extractBasicsFromMain(page);

    const data = {
      ...basics,
      workHistory,
      education: [],
      skills: [],
      connections: 0
    };

    logger.info({ jobs: workHistory.length }, `[li] scrape succeeded${basics.name ? ` (${basics.name})` : ''}`);
    return data;
  } catch (err) {
    logger.error({ err, profileUrl }, '[li] scrape failed — returning fallback');
    return fallbackProfile();
  } finally {
    try { await page?.close(); } catch { /* ignore */ }
  }
}

// ---------- orchestrators ----------
export async function analyzeLinkedInProfile(linkedinUrl: string) {
  return limiter.schedule(async () => {
    logger.info({ linkedinUrl }, '[li] analyzeLinkedInProfile scheduled');
    const raw = await scrapeLinkedInProfile(linkedinUrl);
    return raw;
  });
}

export function parseLinkedInProfile(rawData: any): LinkedInProfile {
  const normalizeWork = (items: any[]): any[] =>
    (items || []).map((x) => ({
      company: x.company || 'Unknown',
      position: x.position || 'Unknown',
      duration: x.duration || '',
      startDate: x.startDate || '',
      endDate: x.endDate || '',
      description: x.description || ''
    }));
  const connections = parseInt(rawData?.connections, 10) || 0;

  return {
    name: rawData?.name || 'Unknown',
    title: rawData?.title || 'No title',
    location: rawData?.location || 'Unknown',
    summary: rawData?.summary || 'No summary available',
    workHistory: normalizeWork(rawData?.workHistory || []),
    education: rawData?.education || [],
    skills: rawData?.skills || [],
    connections,
    profileStrength: Math.min((rawData?.workHistory?.length || 0) * 20 + 20, 100)
  };
}

function fallbackProfile(): LinkedInProfile {
  return {
    name: 'Unknown',
    title: 'Software Professional',
    location: 'Unknown',
    summary:
      'Fallback profile due to login/navigation issues. Ensure valid credentials and consider session reuse or slower pacing.',
    workHistory: [],
    education: [],
    skills: [],
    connections: 0,
    profileStrength: 50
  };
}
