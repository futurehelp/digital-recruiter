// src/services/linkedinScraper.ts
import type { Page } from 'puppeteer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enforceRateLimit, newPage, limiter } from '../lib/browser';
import { LinkedInProfile } from '../types';
import { loadSession, saveSession } from '../lib/session';
import fs from 'fs';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function humanDelay(min = 300, max = 900) {
  const ms = Math.floor(min + Math.random() * (max - min));
  return sleep(ms);
}
async function scrollToBottom(page: Page, step = 250, pause = 120) {
  await page.evaluate(
    async ({ step, pause }) => {
      await new Promise<void>((resolve) => {
        let total = 0;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, step);
          total += step;
          if (total >= scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, pause);
      });
    },
    { step, pause }
  );
}

async function debugDump(page: Page, label: string) {
  try {
    const ts = Date.now();
    const pngPath = `/home/ubuntu/debug-${label}-${ts}.png`;
    const htmlPath = `/home/ubuntu/debug-${label}-${ts}.html`;
    await page.screenshot({ path: pngPath, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(htmlPath, html, 'utf8');
    logger.info({ pngPath, htmlPath }, `[debugDump] wrote ${label}`);
  } catch (err) {
    logger.error({ err }, `[debugDump] failed for ${label}`);
  }
}

async function handleCookieBanner(page: Page) {
  try {
    const banner = await page.$('button[aria-label="Accept cookies"]');
    if (banner) {
      await banner.click().catch(() => {});
      await sleep(500);
    }
  } catch (err) {
    logger.warn({ err }, '[li] cookie banner handler crashed');
    await debugDump(page, 'cookie-crash');
  }
}

/**
 * Try session cookies first. If invalid or missing, do fresh login.
 */
export async function authenticateLinkedIn(): Promise<Page> {
  const page = await newPage();

  // 1) Try session first
  try {
    const loaded = await loadSession(page);
    if (loaded) {
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: env.PAGE_TIMEOUT_MS
      });
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

  // 2) Fresh login
  if (!env.LINKEDIN_EMAIL || !env.LINKEDIN_PASSWORD) {
    throw new Error('LinkedIn credentials required in environment variables');
  }

  logger.info('[li] goto login');
  await page.goto('https://www.linkedin.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: env.PAGE_TIMEOUT_MS
  });
  await debugDump(page, 'login-page');

  try {
    logger.debug('[li] waiting for #username');
    await page.waitForSelector('#username', { timeout: env.ELEMENT_TIMEOUT_MS });
  } catch {
    const curUrl = page.url();
    await debugDump(page, 'login-missing-username');
    logger.error({ url: curUrl }, '[li] username selector not found');
    throw new Error('LinkedIn login page unavailable');
  }

  logger.debug('[li] typing credentials');
  await humanDelay();
  await page.type('#username', env.LINKEDIN_EMAIL, { delay: 80 });
  await humanDelay();
  await page.type('#password', env.LINKEDIN_PASSWORD, { delay: 80 });
  await humanDelay();
  logger.debug('[li] submitting form');
  await page.click('button[type="submit"]');
  await debugDump(page, 'after-submit');

  // Poll for redirect
  const start = Date.now();
  while (Date.now() - start < env.LOGIN_TIMEOUT_MS) {
    await sleep(1000);
    const cur = page.url();
    if (!cur.includes('/login')) break;
  }

  const currentUrl = page.url();
  logger.info({ currentUrl }, '[li] post-login URL');
  if (currentUrl.includes('/checkpoint') || currentUrl.includes('/challenge')) {
    logger.warn('[li] checkpoint/challenge detected');
    await debugDump(page, 'checkpoint');
  }

  if (!currentUrl.includes('/login')) {
    logger.info('[li] authenticated (fresh login)');
    await saveSession(page); // ✅ save new cookies for reuse
    return page;
  }

  const bodyText = await page.$eval('body', (b) => b.innerText).catch(() => '');
  await debugDump(page, 'auth-failed');
  logger.error(
    { currentUrl, bodySnippet: bodyText?.slice(0, 200) || '' },
    '[li] authentication failed'
  );
  throw new Error('Authentication failed at LinkedIn login');
}

/**
 * Scrape full profile data, preferring the /details/experience/ page for work history.
 */
export async function scrapeLinkedInProfile(profileUrl: string): Promise<any> {
  await enforceRateLimit();

  let page: Page | null = null;

  try {
    logger.info({ profileUrl }, '[li] begin scrape');
    page = await authenticateLinkedIn();

    // Construct details URL for experience
    const detailsUrl = `${profileUrl.replace(/\/$/, '')}/details/experience/`;
    logger.info({ detailsUrl }, '[li] goto details/experience page');
    await page.goto(detailsUrl, {
      waitUntil: 'domcontentloaded',
      timeout: env.PAGE_TIMEOUT_MS
    });
    await debugDump(page, 'after-details');

    await handleCookieBanner(page);

    // Wait for job entries
    await page.waitForSelector('.optional-action-target-wrapper', {
      timeout: env.ELEMENT_TIMEOUT_MS
    }).catch(async (err) => {
      logger.error({ err }, '[li] selector timeout at details page');
      await debugDump(page!, 'details-timeout');
      throw err;
    });

    await sleep(2000);
    await scrollToBottom(page);
    await sleep(1000);

    logger.debug('[li] extracting work history from details page');
    const workHistory = await page.evaluate(() => {
      const clean = (t?: string | null) => (t || '').replace(/\s+/g, ' ').trim();

      return Array.from(document.querySelectorAll('li')).map((li) => {
        const position = clean(li.querySelector('.t-bold')?.textContent);
        const company = clean(
          li.querySelector('.t-14.t-normal')?.textContent ||
            li.querySelector('.t-normal span')?.textContent
        );
        const duration = clean(
          li.querySelector('.t-14.t-black--light')?.textContent ||
            li.querySelector('.t-14.t-normal.t-black--light')?.textContent
        );
        const description = clean(
          li.querySelector('.pv-shared-text-with-see-more')?.textContent ||
            li.querySelector('.inline-show-more-text')?.textContent
        );

        if (position || company) {
          return {
            position,
            company,
            duration,
            description
          };
        }
        return null;
      }).filter(Boolean);
    });

    // Basic profile info still comes from main page
    logger.info('[li] back to main profile for summary');
    await page.goto(profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: env.PAGE_TIMEOUT_MS
    });
    await debugDump(page, 'after-main');

    const basics = await page.evaluate(() => {
      const clean = (t?: string | null) => (t || '').replace(/\s+/g, ' ').trim();
      return {
        name: clean(document.querySelector('.text-heading-xlarge, h1')?.textContent),
        title: clean(document.querySelector('.text-body-medium.break-words')?.textContent),
        location: clean(document.querySelector('.text-body-small.inline')?.textContent),
        summary: ''
      };
    });

    const data = { ...basics, workHistory, education: [], skills: [], connections: 0 };
    logger.info(
      { name: data?.name || '(unknown)', jobs: workHistory.length },
      '[li] scrape succeeded'
    );
    return data;
  } catch (err) {
    await debugDump(page!, 'scrape-error');
    logger.error({ err, profileUrl }, '[li] scrape failed — returning fallback');
    return fallbackProfile();
  } finally {
    try {
      await page?.close();
    } catch {
      /* ignore */
    }
  }
}

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
