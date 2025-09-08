// src/services/linkedinScraper.ts
import fs from 'fs';
import type { Page } from 'puppeteer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enforceRateLimit, newPage, limiter } from '../lib/browser';
import { LinkedInProfile } from '../types';
import { loadSession, saveSession } from '../lib/session';

/* ----------------------------- small helpers ------------------------------ */

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

async function waitForAnySelector(
  page: Page,
  selectors: string[],
  timeout: number
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const found = await page.$(sel);
        if (found) return sel;
      } catch {
        /* ignore bad selectors just in case */
      }
    }
    await sleep(300);
  }
  return null;
}

async function debugDump(page: Page, tag: string) {
  try {
    const base = `/home/ubuntu/debug-${tag}-${Date.now()}`;
    const png = `${base}.png`;
    const htmlPath = `${base}.html`;
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    fs.writeFileSync(htmlPath, html);
    logger.warn({ png, html: htmlPath }, `[debug] dump saved (${tag})`);
  } catch (e) {
    logger.warn({ err: e }, '[debug] dump failed');
  }
}

async function handleCookieBanner(page: Page) {
  // Puppeteer-safe: scan all buttons by text
  const clicked = await page.evaluate(() => {
    const tryTexts = ['accept', 'allow all', 'i accept', 'agree'];
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) {
      const t = (b.textContent || '').trim().toLowerCase();
      if (tryTexts.some((x) => t.includes(x))) {
        (b as HTMLButtonElement).click();
        return true;
      }
    }
    return false;
  });
  if (clicked) await sleep(400);
}

async function clickByText(page: Page, texts: string[]) {
  const handle = await page.evaluateHandle((btnTexts: string[]) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const lowers = btnTexts.map((t) => t.toLowerCase());
    return (
      btns.find((b) => {
        const t = (b.textContent || '').toLowerCase();
        return lowers.some((x) => t.includes(x));
      }) || null
    );
  }, texts);

  try {
    if (handle) {
      const el = handle.asElement();
      if (el) {
        // IMPORTANT: use evaluate to click to avoid Element vs Node type mismatch
        await el.evaluate((btn) => (btn as HTMLElement).click()).catch(() => {});
        await sleep(800);
      }
    }
  } catch {
    /* ignore */
  } finally {
    try {
      // @ts-ignore - dispose if it’s a JSHandle
      await (handle as any)?.dispose?.();
    } catch {}
  }
}

/* ------------------------------ authentication ---------------------------- */

export async function authenticateLinkedIn(): Promise<Page> {
  const page = await newPage();

  // Be explicit about UA on EC2
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
  );

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

  // Wait to leave /login
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
    // Try a generic "Continue"/"Verify" click, Puppeteer-safe
    await clickByText(page, ['continue', 'verify', 'next']);
    await handleCookieBanner(page);
    // Give it a moment to advance if it can
    await sleep(1500);
  }

  // Cookie banner sometimes appears right after login
  await handleCookieBanner(page);

  if (!currentUrl.includes('/login')) {
    logger.info('[li] authenticated (fresh login)');
    await saveSession(page); // save new cookies for reuse
    return page;
  }

  await debugDump(page, 'login-failed');
  const bodyText = await page.$eval('body', (b) => (b as HTMLElement).innerText).catch(() => '');
  logger.error(
    { currentUrl, bodySnippet: bodyText?.slice(0, 200) || '' },
    '[li] authentication failed'
  );
  throw new Error('Authentication failed at LinkedIn login');
}

/* --------------------------------- scraper -------------------------------- */

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

    await handleCookieBanner(page);

    // Try several anchors (LinkedIn DOM changes a lot)
    const experienceAnchors = [
      '.optional-action-target-wrapper',                // original
      'section[data-view-name*="experience"]',         // new IA
      '#profile-content',                              // legacy container
      'main[role="main"]'                              // generic fallback
    ];

    const hit = await waitForAnySelector(page, experienceAnchors, env.ELEMENT_TIMEOUT_MS);
    if (!hit) {
      await debugDump(page, 'experience-timeout');
      throw new Error('Experience section not found in time');
    }

    // Hydrate lazy content
    await sleep(1500);
    await scrollToBottom(page);
    await sleep(800);

    logger.debug('[li] extracting work history from details page');
    const workHistory = await page.evaluate(() => {
      const clean = (t?: string | null) => (t || '').replace(/\s+/g, ' ').trim();

      const expRoot =
        document.querySelector('section[data-view-name*="experience"]') ||
        document.querySelector('#profile-content') ||
        document;

      return Array.from(expRoot.querySelectorAll('li'))
        .map((li) => {
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
            return { position, company, duration, description };
          }
          return null;
        })
        .filter(Boolean);
    });

    // Basic profile info from main page
    logger.info('[li] back to main profile for summary');
    await page.goto(profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: env.PAGE_TIMEOUT_MS
    });

    await handleCookieBanner(page);

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

/* ------------------------------ orchestrator ------------------------------ */

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
