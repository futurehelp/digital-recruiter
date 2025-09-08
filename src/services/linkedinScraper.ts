import type { Page } from 'puppeteer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enforceRateLimit, newPage, limiter } from '../lib/browser';
import { LinkedInProfile } from '../types';
import { loadSession, saveSession } from '../lib/session';
import { warmPageForScrape, expandShowMore, killCookieBanners } from '../lib/pageReady';

const SLOW_MS = 600_000; // up to 10 minutes
const PAGE_MS = 600_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const human = (min = 250, max = 700) => sleep(Math.floor(min + Math.random() * (max - min)));

function clean(t?: string | null) {
  return (t || '').replace(/\s+/g, ' ').trim();
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

  try {
    const loaded = await loadSession(page);
    if (loaded) {
      await warmPageForScrape(page, 'https://www.linkedin.com/feed/', 'session-check');
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

  if (!env.LINKEDIN_EMAIL || !env.LINKEDIN_PASSWORD) {
    throw new Error('Missing LINKEDIN_EMAIL / LINKEDIN_PASSWORD env vars');
  }

  await warmPageForScrape(page, 'https://www.linkedin.com/login', 'login-page');
  await debugDump(page, 'login-page');

  await page.waitForSelector('#username', { timeout: SLOW_MS }).catch(() => {});
  await human(); await page.type('#username', env.LINKEDIN_EMAIL, { delay: 70 });
  await human(); await page.type('#password', env.LINKEDIN_PASSWORD, { delay: 70 });
  await human(200, 500);

  await Promise.allSettled([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: PAGE_MS }).catch(() => {})
  ]);

  await debugDump(page, 'after-submit');
  const currentUrl = page.url();
  logger.info({ currentUrl }, '[li] post-login URL');

  await saveSession(page);
  return page;
}

// ---------- scraping helpers ----------
async function extractExperience(page: Page) {
  await page.waitForSelector('li.pvs-list__paged-list-item', { timeout: SLOW_MS }).catch(() => {});
  await expandShowMore(page);
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
    function heuristicLines(container: Element): string[] {
      const spans = Array.from(container.querySelectorAll('span'))
        .map(s => clean((s as HTMLElement).innerText || s.textContent || ''))
        .filter(Boolean);
      return Array.from(new Set(spans)).slice(0, 6);
    }

    return Array.from(document.querySelectorAll('li.pvs-list__paged-list-item')).map(li => {
      const main =
        li.querySelector<HTMLElement>('div.display-flex.flex-column.align-self-center.flex-grow-1') ||
        li.querySelector<HTMLElement>('div.pvs-entity');
      if (!main) {
        const lines = heuristicLines(li);
        const [position = '', company = '', duration = ''] = lines;
        return { position, company, duration, description: '' };
      }
      const position =
        pick(main, [
          '.mr1.hoverable-link-text.t-bold span',
          'span[aria-hidden="true"]',
          '.t-bold',
          'a[aria-hidden="true"] span',
        ]) || heuristicLines(main)[0] || '';
      const company =
        pick(main, [
          '.t-14.t-normal',
          '.pv-entity__secondary-title',
          'a[href*="/company/"] span[aria-hidden="true"]',
        ]) || heuristicLines(main)[1] || '';
      const duration =
        pick(main, [
          '.t-14.t-normal.t-black--light',
          '.pv-entity__date-range span:nth-child(2)',
          'span:has(time)'
        ]) || (heuristicLines(main).find(t => /·|month|year|Present|20\d{2}/i.test(t)) || '');
      const description =
        pick(li, [
          '.inline-show-more-text',
          '.pv-shared-text-with-see-more',
          '[data-test-description]'
        ]);
      return { position, company, duration, description };
    }).filter(x => x.position || x.company);
  });

  return items;
}

async function extractBasics(page: Page) {
  await killCookieBanners(page);
  await page.waitForSelector('.pv-text-details__left-panel, .mt2', { timeout: SLOW_MS }).catch(() => {});
  return await page.evaluate(() => {
    const clean = (t?: string | null) => (t || '').replace(/\s+/g, ' ').trim();
    const name =
      clean(document.querySelector('.text-heading-xlarge, h1')?.textContent) ||
      clean(document.querySelector('h1')?.textContent);
    const title = clean(document.querySelector('.text-body-medium.break-words')?.textContent);
    const location = clean(document.querySelector('.text-body-small.inline, [data-test-location]')?.textContent);
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

    const detailsUrl = `${profileUrl.replace(/\/$/, '')}/details/experience/`;
    logger.info({ detailsUrl }, '[li] goto details/experience page');
    await warmPageForScrape(page, detailsUrl, 'details-experience');
    await debugDump(page, 'after-details');

    let workHistory = await extractExperience(page).catch(() => []);
    if (workHistory.length === 0) {
      logger.warn('[li] details page empty, trying main profile experience');
      await warmPageForScrape(page, profileUrl, 'main-experience-fallback');
      await expandShowMore(page);
      workHistory = await extractExperience(page).catch(() => []);
    }

    logger.info('[li] back to main profile for summary');
    await warmPageForScrape(page, profileUrl, 'main-profile');
    await debugDump(page, 'after-main');

    const basics = await extractBasics(page);

    return {
      ...basics,
      workHistory,
      education: [],
      skills: [],
      connections: 0
    };
  } finally {
    try { await page?.close(); } catch { /* ignore */ }
  }
}

// ---------- orchestrators ----------
export async function analyzeLinkedInProfile(linkedinUrl: string) {
  return limiter.schedule(async () => {
    logger.info({ linkedinUrl }, '[li] analyzeLinkedInProfile scheduled');
    return await scrapeLinkedInProfile(linkedinUrl);
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
