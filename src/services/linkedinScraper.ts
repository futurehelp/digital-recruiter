// src/services/linkedinScraper.ts
import type { Page } from 'puppeteer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enforceRateLimit, newPage, limiter } from '../lib/browser';
import { LinkedInProfile } from '../types';
import { loadSession, saveSession } from '../lib/session';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ensures an env value is a non-empty string; throws early if missing. */
function requireEnv(name: string, value: unknown): string {
  const v = (value ?? '').toString();
  if (!v) {
    const msg = `[config] Missing required environment variable ${name}`;
    logger.error(msg);
    throw new Error(msg);
  }
  return v;
}

// ---------- Simple Authentication ----------
export async function authenticateLinkedIn(): Promise<Page> {
  const page = await newPage();

  try {
    logger.info('[li] Starting authentication');

    // Try to load saved session
    const hasSession = await loadSession(page);
    if (hasSession) {
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      // Check if logged in
      const url = page.url();
      if (!url.includes('/login') && !url.includes('/checkpoint')) {
        logger.info('[li] Authenticated via saved session');
        return page;
      }
    }

    // Need to login
    logger.info('[li] Logging in with credentials');
    await page.goto('https://www.linkedin.com/login', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // Wait for login form
    await page.waitForSelector('#username', { timeout: 30000 });
    await page.waitForSelector('#password', { timeout: 30000 });

    // 🔒 Safely coerce env to strings (throws if missing) → fixes TS errors
    const email = requireEnv('LINKEDIN_EMAIL', env.LINKEDIN_EMAIL);
    const password = requireEnv('LINKEDIN_PASSWORD', env.LINKEDIN_PASSWORD);

    // Type credentials - SIMPLE approach that works
    await page.type('#username', email, { delay: 100 });
    await sleep(500);
    await page.type('#password', password, { delay: 100 });
    await sleep(500);

    // Click submit
    await page.click('button[type="submit"]');

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(2000);

    // Save session
    await saveSession(page);

    const currentUrl = page.url();
    logger.info({ currentUrl }, '[li] Login complete');

    return page;
  } catch (err) {
    logger.error({ err }, '[li] Authentication failed');
    throw err;
  }
}

// ---------- Extract Profile Data ----------
async function extractWorkHistory(page: Page) {
  try {
    // Wait for experience section
    await page
      .waitForSelector('li.pvs-list__paged-list-item', { timeout: 10000 })
      .catch(() => {});

    return await page.evaluate(() => {
      const items: any[] = [];
      const experiences = document.querySelectorAll('li.pvs-list__paged-list-item');

      experiences.forEach((exp) => {
        const position = exp.querySelector('.t-bold span')?.textContent?.trim() || '';
        const company = exp.querySelector('.t-14.t-normal')?.textContent?.trim() || '';
        const duration =
          Array.from(exp.querySelectorAll('.t-14.t-normal.t-black--light'))
            .map((el) => el.textContent?.trim())
            .find((text) => text?.includes('·')) || '';

        if (position || company) {
          items.push({ position, company, duration, description: '' });
        }
      });

      return items;
    });
  } catch (err) {
    logger.warn('[li] Could not extract work history');
    return [];
  }
}

async function extractBasicInfo(page: Page) {
  try {
    await page.waitForSelector('h1', { timeout: 10000 });

    return await page.evaluate(() => {
      const name = document.querySelector('h1')?.textContent?.trim() || 'Unknown';
      const title = document.querySelector('.text-body-medium.break-words')?.textContent?.trim() || '';
      const location = document.querySelector('.text-body-small.inline')?.textContent?.trim() || '';

      return { name, title, location, summary: '' };
    });
  } catch (err) {
    logger.warn('[li] Could not extract basic info');
    return { name: 'Unknown', title: '', location: '', summary: '' };
  }
}

// ---------- Main Scrape Function ----------
export async function scrapeLinkedInProfile(profileUrl: string): Promise<any> {
  await enforceRateLimit();

  let page: Page | null = null;

  try {
    logger.info({ profileUrl }, '[li] Starting scrape');

    // Authenticate
    page = await authenticateLinkedIn();

    // Go to profile
    logger.info('[li] Navigating to profile');
    await page.goto(profileUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    await sleep(2000);

    // Get basic info
    const basics = await extractBasicInfo(page);

    // Try to get experience from main page first
    let workHistory = await extractWorkHistory(page);

    // If no experience found, try details page
    if (workHistory.length === 0) {
      const detailsUrl = `${profileUrl.replace(/\/$/, '')}/details/experience/`;
      logger.info('[li] Trying experience details page');

      await page.goto(detailsUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      await sleep(2000);
      workHistory = await extractWorkHistory(page);
    }

    // Save session for next time
    await saveSession(page);

    return {
      ...basics,
      workHistory,
      education: [],
      skills: [],
      connections: 0,
    };
  } catch (err) {
    logger.error({ err, profileUrl }, '[li] Scrape failed');
    throw err;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

// ---------- Public Functions ----------
export async function analyzeLinkedInProfile(linkedinUrl: string) {
  return limiter.schedule(async () => {
    logger.info({ linkedinUrl }, '[li] Analysis scheduled');
    return await scrapeLinkedInProfile(linkedinUrl);
  });
}

export function parseLinkedInProfile(rawData: any): LinkedInProfile {
  const normalizeWork = (items: any[]): any[] =>
    (items || []).map((x) => ({
      company: x.company || 'Unknown',
      position: x.position || 'Unknown',
      duration: x.duration || '',
      startDate: '',
      endDate: '',
      description: x.description || '',
    }));

  return {
    name: rawData?.name || 'Unknown',
    title: rawData?.title || 'No title',
    location: rawData?.location || 'Unknown',
    summary: rawData?.summary || 'No summary available',
    workHistory: normalizeWork(rawData?.workHistory || []),
    education: rawData?.education || [],
    skills: rawData?.skills || [],
    connections: 0,
    profileStrength: Math.min((rawData?.workHistory?.length || 0) * 20 + 20, 100),
  };
}
