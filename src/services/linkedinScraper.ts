import type { Page, ElementHandle } from 'puppeteer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enforceRateLimit, newPage, limiter } from '../lib/browser';
import { LinkedInProfile } from '../types';
import { loadSession, saveSession } from '../lib/session';
import fs from 'fs';
import path from 'path';

/* ------------------------ tiny utils ------------------------ */
const DUMP_DIR = '/home/ubuntu';
function nowMs() {
  return Date.now();
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function humanDelay(min = 200, max = 650) {
  const ms = Math.floor(min + Math.random() * (max - min));
  return sleep(ms);
}
function fileSafe(label: string) {
  return label.replace(/[^a-z0-9-_]/gi, '_').slice(0, 80);
}

/* ------------------------ navigation helpers ------------------------ */
async function waitForNetworkIdleLoose(page: Page, timeout = 10000) {
  // Puppeteer has page.waitForNetworkIdle in newer versions; fall back to domcontentloaded cycle
  try {
    // @ts-ignore - available in recent puppeteer
    if (typeof (page as any).waitForNetworkIdle === 'function') {
      await (page as any).waitForNetworkIdle({ timeout });
      return;
    }
  } catch {}
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }).catch(() => {});
}

async function safeGoto(page: Page, url: string, label?: string) {
  const start = nowMs();
  const nav = page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: env.PAGE_TIMEOUT_MS
  });

  // Race goto + a secondary "idle" wait so we don't evaluate during navigation
  await Promise.race([
    nav,
    (async () => {
      // backstop if goto resolves instantly
      await sleep(250);
    })()
  ]).catch(() => {});

  // A second barrier for network quietness
  await waitForNetworkIdleLoose(page, Math.min(15000, (env.PAGE_TIMEOUT_MS || 60000) / 4));

  const took = nowMs() - start;
  logger.debug({ url, tookMs: took, label }, '[nav] safeGoto settled');
}

/* ------------------------ debug dump (resilient) ------------------------ */
async function debugDump(page: Page, label: string) {
  const ts = nowMs();
  const base = `${fileSafe(label)}-${ts}`;
  const pngPath = path.join(DUMP_DIR, `debug-${base}.png`);
  const htmlPath = path.join(DUMP_DIR, `debug-${base}.html`);

  try {
    // Give nav a moment to settle to avoid exec-context-destroyed
    await sleep(150);
    await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
    let html = '';
    for (let i = 0; i < 3; i++) {
      try {
        html = await page.evaluate(() => document.documentElement.outerHTML);
        break;
      } catch {
        await sleep(200);
      }
    }
    if (html) {
      fs.writeFileSync(htmlPath, html, 'utf8');
      logger.info({ pngPath, htmlPath }, '[debugDump] wrote ' + label);
    } else {
      logger.info({ pngPath }, '[debugDump] wrote screenshot only (HTML unavailable)');
    }
  } catch (err: any) {
    logger.error({ err }, `[debugDump] failed for ${label}`);
  }
}

/* ------------------------ DOM helpers ------------------------ */
async function clickByText(page: Page, tag: string, substrings: string[]) {
  const lc = substrings.map((s) => s.toLowerCase());
  const handle = await page.evaluateHandle(
    ({ tag, lc }) => {
      const nodes = Array.from(document.querySelectorAll(tag));
      return nodes.find((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        return lc.some((s) => t.includes(s));
      }) || null;
    },
    { tag, lc }
  );
  const el = handle.asElement();
  if (el) {
    // Cast to Element handle for TS
    await (el as unknown as ElementHandle<Element>).click({ delay: 50 }).catch(() => {});
    return true;
  }
  return false;
}

async function handleCookieBanner(page: Page) {
  // Handle common consent banners via friendly heuristics
  try {
    const clicked =
      (await clickByText(page, 'button', ['accept', 'agree', 'allow all'])) ||
      (await clickByText(page, 'button', ['okay', 'ok'])) ||
      (await clickByText(page, 'button', ['continue']));
    if (clicked) {
      await sleep(300);
    }
  } catch {
    /* ignore */
  }
}

async function scrollToBottom(page: Page, step = 500, pause = 200) {
  await page.evaluate(
    async ({ step, pause }) => {
      await new Promise<void>((resolve) => {
        let lastY = 0;
        const id = setInterval(() => {
          window.scrollBy(0, step);
          if (window.scrollY === lastY) {
            clearInterval(id);
            resolve();
            return;
          }
          lastY = window.scrollY;
        }, pause);
      });
    },
    { step, pause }
  );
}

/* ------------------------ auth + session ------------------------ */
async function postLoginCheckpointHandling(page: Page) {
  const url = page.url();
  if (/\/checkpoint|\/challenge/.test(url)) {
    logger.warn('[li] checkpoint/challenge detected');
    await debugDump(page, 'checkpoint');
    // Let human solve via DevTools tunnel if needed; we proceed optimistically.
  }
}

export async function authenticateLinkedIn(): Promise<Page> {
  const page = await newPage();

  // 1) Try session first
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

  // 2) Fresh login
  if (!env.LINKEDIN_EMAIL || !env.LINKEDIN_PASSWORD) {
    throw new Error('LinkedIn credentials required in environment variables');
  }

  logger.info('[li] goto login');
  await safeGoto(page, 'https://www.linkedin.com/login', 'login-page');
  await debugDump(page, 'login-page');

  try {
    await page.waitForSelector('#username', { timeout: env.ELEMENT_TIMEOUT_MS });
  } catch {
    const curUrl = page.url();
    logger.error({ url: curUrl }, '[li] username selector not found');
    throw new Error('LinkedIn login page unavailable');
  }

  logger.debug('[li] typing credentials');
  await humanDelay();
  await page.type('#username', env.LINKEDIN_EMAIL, { delay: 50 });
  await humanDelay();
  await page.type('#password', env.LINKEDIN_PASSWORD, { delay: 60 });
  await humanDelay();

  logger.debug('[li] submitting form');
  await Promise.allSettled([
    page.click('button[type="submit"]').catch(() => {}),
    // allow immediate transition
    sleep(150)
  ]);
  await debugDump(page, 'after-submit');

  // Poll until we leave /login (up to LOGIN_TIMEOUT_MS)
  const start = nowMs();
  while (nowMs() - start < (env.LOGIN_TIMEOUT_MS || 90000)) {
    await sleep(600);
    const cur = page.url();
    if (!/\/login/.test(cur)) break;
  }

  await postLoginCheckpointHandling(page);

  const currentUrl = page.url();
  logger.info({ currentUrl }, '[li] post-login URL');

  if (!/\/login/.test(currentUrl)) {
    logger.info('[li] authenticated (fresh login)');
    await saveSession(page);
    return page;
  }

  const bodyText = await page.$eval('body', (b) => b.innerText).catch(() => '');
  logger.error({ currentUrl, bodySnippet: String(bodyText).slice(0, 200) }, '[li] authentication failed');
  throw new Error('Authentication failed at LinkedIn login');
}

/* ------------------------ scraping ------------------------ */
async function extractExperienceFromDetails(page: Page) {
  // On details/experience, there are many list items. We collect reasonable fields.
  await handleCookieBanner(page);
  await page.waitForSelector('main', { timeout: env.ELEMENT_TIMEOUT_MS }).catch(() => {});
  await sleep(1000);
  await scrollToBottom(page, 600, 200);
  await sleep(500);

  const workHistory = await page.evaluate(() => {
    const clean = (t?: string | null) => (t || '').replace(/\s+/g, ' ').trim();
    const items: any[] = [];
    const liNodes = Array.from(document.querySelectorAll('li'));
    for (const li of liNodes) {
      const position =
        clean((li.querySelector('.t-bold') as HTMLElement | null)?.textContent) ||
        clean((li.querySelector('span[aria-hidden="true"]') as HTMLElement | null)?.textContent);

      const company =
        clean((li.querySelector('.t-14.t-normal') as HTMLElement | null)?.textContent) ||
        clean((li.querySelector('.t-normal span') as HTMLElement | null)?.textContent);

      const duration =
        clean((li.querySelector('.t-14.t-black--light') as HTMLElement | null)?.textContent) ||
        clean((li.querySelector('.t-14.t-normal.t-black--light') as HTMLElement | null)?.textContent);

      const description =
        clean((li.querySelector('.pv-shared-text-with-see-more') as HTMLElement | null)?.textContent) ||
        clean((li.querySelector('.inline-show-more-text') as HTMLElement | null)?.textContent);

      if (position || company || duration || description) {
        items.push({ position, company, duration, description });
      }
    }
    return items.slice(0, 50);
  });

  return workHistory;
}

async function extractBasicsFromMain(page: Page) {
  await handleCookieBanner(page);
  await page.waitForSelector('main, h1', { timeout: env.ELEMENT_TIMEOUT_MS }).catch(() => {});
  await sleep(600);

  const basics = await page.evaluate(() => {
    const clean = (t?: string | null) => (t || '').replace(/\s+/g, ' ').trim();
    return {
      name: clean(document.querySelector('.text-heading-xlarge, h1')?.textContent),
      title: clean(document.querySelector('.text-body-medium.break-words')?.textContent),
      location: clean(document.querySelector('.text-body-small.inline')?.textContent),
      summary: ''
    };
  });

  return basics;
}

export async function scrapeLinkedInProfile(profileUrl: string): Promise<any> {
  await enforceRateLimit();

  let page: Page | null = null;

  try {
    logger.info({ profileUrl }, '[li] begin scrape');
    page = await authenticateLinkedIn();

    // 1) Try details/experience first
    const detailsUrl = `${profileUrl.replace(/\/$/, '')}/details/experience/`;
    logger.info({ detailsUrl }, '[li] goto details/experience page');
    await safeGoto(page, detailsUrl, 'details-experience');
    await debugDump(page, 'after-details');

    // If LinkedIn bounced us to a checkpoint/login again, stop early
    const cur1 = page.url();
    if (/\/login|\/checkpoint|\/challenge/.test(cur1)) {
      logger.warn({ cur1 }, '[li] bounced away from details page');
      throw new Error('Bounced to checkpoint/login');
    }

    // Wait for some content and extract
    const workHistory = await extractExperienceFromDetails(page).catch(async (err) => {
      logger.warn({ err }, '[li] details/experience extraction failed; trying main page fallback');
      return [] as any[];
    });

    // 2) Go back to main profile for basics
    logger.info('[li] back to main profile for summary');
    await safeGoto(page, profileUrl, 'main-profile');
    await debugDump(page, 'after-main');

    const basics = await extractBasicsFromMain(page).catch(() => ({
      name: '',
      title: '',
      location: '',
      summary: ''
    }));

    const data = {
      ...basics,
      workHistory,
      education: [],
      skills: [],
      connections: 0
    };

    logger.info({ name: data?.name || '(unknown)', jobs: workHistory.length }, '[li] scrape succeeded');
    return data;
  } catch (err) {
    logger.error({ err, profileUrl }, '[li] scrape failed — returning fallback');
    return fallbackProfile();
  } finally {
    try {
      await page?.close();
    } catch { /* ignore */ }
  }
}

/* ------------------------ pipeline ------------------------ */
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
