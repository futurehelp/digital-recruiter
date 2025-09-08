// src/services/linkedinScraper.ts
import type { Page } from 'puppeteer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enforceRateLimit, newPage, limiter } from '../lib/browser';
import { LinkedInProfile } from '../types';
import { loadSession, saveSession, ensureFreshSession } from '../lib/session';
import { warmPageForScrape, expandShowMore, killCookieBanners, autoScroll } from '../lib/pageReady';

const SLOW_MS = 600_000; // up to 10 minutes everywhere
const PAGE_MS = 600_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const human = (min = 200, max = 600) => sleep(Math.floor(min + Math.random() * (max - min)));

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

/** Wait for and return the first existing selector from a list. */
async function waitAnySelector(page: Page, selectors: string[], timeout = SLOW_MS): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) return sel;
      } catch { /* ignore */ }
    }
    await sleep(250);
  }
  return null;
}

/** Type into an input robustly (fallback to direct value set if overlayed). */
async function robustType(page: Page, selector: string, value: string) {
  try {
    await page.focus(selector);
    await human(80, 160);
    await page.click(selector, { clickCount: 3 }).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await human(60, 120);
    await page.type(selector, value, { delay: 60 });
  } catch {
    // fallback: set value via JS if type failed (e.g., overlay, masked)
    await page.evaluate((sel, val) => {
      const el = document.querySelector<HTMLInputElement>(sel);
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector, value);
  }
}

/** Click a button with common text variants (Sign in / Continue). */
async function clickLoginSubmit(page: Page) {
  const tried = await page.evaluate(() => {
    const variants = ['sign in', 'log in', 'continue', 'submit'];
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]'));
    const visible = (el: HTMLElement) => {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    for (const el of nodes) {
      if (!visible(el)) continue;
      const txt = (el.innerText || el.getAttribute('value') || el.textContent || '').toLowerCase().trim();
      if (variants.some(v => txt.includes(v))) {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!tried) {
    // fallback: try common selectors
    const candidates = [
      'button[type="submit"]',
      'button.sign-in-form__submit-button',
      'input[type="submit"]'
    ];
    for (const sel of candidates) {
      const el = await page.$(sel);
      if (el) {
        await el.click().catch(() => {});
        return;
      }
    }
  }
}

/** Bring up a login form if LinkedIn shows a “home” or “marketing” page */
async function tryClickTopNavSignIn(page: Page) {
  const clicked = await page.evaluate(() => {
    const textMatches = (el: HTMLElement, needles: string[]) => {
      const t = (el.innerText || el.textContent || '').toLowerCase();
      return needles.some(n => t.includes(n));
    };
    const btns = Array.from(document.querySelectorAll<HTMLElement>('a, button'));
    for (const b of btns) {
      if (textMatches(b, ['sign in', 'log in'])) {
        b.click();
        return true;
      }
    }
    return false;
  });
  if (clicked) {
    await sleep(1200);
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  }
}

// ---------- auth ----------
export async function authenticateLinkedIn(): Promise<Page> {
  const page = await newPage();

  // 1) Try saved session
  try {
    const loaded = await loadSession(page);
    if (loaded) {
      await warmPageForScrape(page, 'https://www.linkedin.com/feed/', 'session-check');
      const url = page.url();
      logger.info({ url }, '[li] session check /feed');
      if (!/\/login|\/checkpoint|\/challenge/.test(url)) {
        logger.info('[li] ✅ Authenticated via saved session');
        await ensureFreshSession(page).catch(() => {});
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

  // 2) Navigate to a login form (try multiple entry points)
  const loginUrls = [
    'https://www.linkedin.com/login',
    'https://www.linkedin.com/uas/login',
    'https://www.linkedin.com/login?fromSignIn=true&trk=guest_homepage-basic_nav-header-signin'
  ];

  let onLogin = false;
  for (const url of loginUrls) {
    await warmPageForScrape(page, url, 'login-page');
    await debugDump(page, 'login-page');
    await killCookieBanners(page);
    // If no inputs yet, try a top nav "Sign in" click (home/marketing variant)
    await tryClickTopNavSignIn(page);
    // Heuristic: look for any username/password inputs
    const userSel = await waitAnySelector(page, ['#username', '#session_key', 'input[name="session_key"]', 'input[name="username"]'], 5000);
    const passSel = await waitAnySelector(page, ['#password', '#session_password', 'input[name="session_password"]', 'input[type="password"]'], 5000);
    if (userSel || passSel) {
      onLogin = true;
      break;
    }
  }

  // 3) If still not on a login form, give one last chance by going to the home and clicking sign-in
  if (!onLogin) {
    await warmPageForScrape(page, 'https://www.linkedin.com/', 'home-then-login');
    await tryClickTopNavSignIn(page);
    await killCookieBanners(page);
  }

  // 4) Locate username/password inputs using robust selector sets
  const usernameSelectors = ['#username', '#session_key', 'input[name="session_key"]', 'input[name="username"]', 'input[id*="session_key"]'];
  const passwordSelectors = ['#password', '#session_password', 'input[name="session_password"]', 'input[type="password"]', 'input[id*="session_password"]'];

  const userSel = await waitAnySelector(page, usernameSelectors, 60_000);
  const passSel = await waitAnySelector(page, passwordSelectors, 60_000);

  if (!userSel || !passSel) {
    await debugDump(page, 'login-missing-inputs');
    throw new Error(`LinkedIn login inputs not found (userSel=${userSel}, passSel=${passSel})`);
  }

  await robustType(page, userSel, env.LINKEDIN_EMAIL);
  await human(150, 300);
  await robustType(page, passSel, env.LINKEDIN_PASSWORD);
  await human(250, 500);

  await clickLoginSubmit(page);
  // Wait for either feed or challenge
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: PAGE_MS }).catch(() => {});
  await killCookieBanners(page);
  await autoScroll(page, 5_000);

  const currentUrl = page.url();
  logger.info({ currentUrl }, '[li] post-login URL');
  await debugDump(page, 'after-submit');

  // Save new session (even if a checkpoint shows; cookies still useful later)
  await saveSession(page);
  await ensureFreshSession(page).catch(() => {});
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
      return Array.from(new Set(spans)).slice(0, 8);
    }

    return Array.from(document.querySelectorAll('li.pvs-list__paged-list-item')).map(li => {
      const main =
        li.querySelector<HTMLElement>('div.display-flex.flex-column.align-self-center.flex-grow-1') ||
        li.querySelector<HTMLElement>('div.pvs-entity') || li;

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

      const durationCandidate =
        pick(main, ['.t-14.t-normal.t-black--light']) ||
        heuristicLines(main).find(t => /·|month|year|present|20\d{2}/i.test(t)) || '';
      const description =
        pick(li, [
          '.inline-show-more-text',
          '.pv-shared-text-with-see-more',
          '[data-test-description]'
        ]);

      return { position, company, duration: durationCandidate, description };
    }).filter(x => x.position || x.company);
  });

  return items as Array<{ position: string; company: string; duration: string; description: string }>;
}

async function extractBasics(page: Page) {
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

    // DETAILS page (experience)
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
