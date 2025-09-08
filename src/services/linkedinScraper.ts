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
const randomDelay = (min = 1000, max = 3000) => sleep(Math.floor(min + Math.random() * (max - min)));

function clean(t?: string | null) {
  return (t || '').replace(/\s+/g, ' ').trim();
}

async function debugDump(page: Page, tag: string) {
  // Skip debug screenshots unless explicitly enabled via environment variable
  if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
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

/** Simulate human-like mouse movements */
async function humanMouseMovement(page: Page) {
  try {
    const viewport = page.viewport();
    if (!viewport) return;
    
    // Move mouse in a curve-like pattern
    const points = [
      { x: 100, y: 100 },
      { x: 300 + Math.random() * 200, y: 200 + Math.random() * 100 },
      { x: 600 + Math.random() * 300, y: 400 + Math.random() * 200 },
      { x: 400 + Math.random() * 200, y: 300 + Math.random() * 100 }
    ];
    
    for (const point of points) {
      await page.mouse.move(point.x, point.y, { steps: 10 });
      await sleep(100 + Math.random() * 200);
    }
  } catch {
    // Ignore mouse movement errors
  }
}

/** Simulate human-like scrolling */
async function humanScroll(page: Page) {
  try {
    await page.evaluate(() => {
      const totalHeight = document.body.scrollHeight;
      const viewportHeight = window.innerHeight;
      let currentPosition = 0;
      
      const scroll = () => {
        const scrollAmount = 100 + Math.random() * 200;
        currentPosition += scrollAmount;
        window.scrollBy(0, scrollAmount);
        
        if (currentPosition < totalHeight - viewportHeight) {
          setTimeout(scroll, 100 + Math.random() * 300);
        }
      };
      
      scroll();
    });
    await sleep(2000 + Math.random() * 1000);
  } catch {}
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

/** Type into an input robustly with human-like behavior */
async function robustType(page: Page, selector: string, value: string) {
  try {
    // Click the input first
    await page.click(selector);
    await human(100, 300);
    
    // Clear existing content
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await human(100, 200);
    
    // Type character by character with random delays
    for (const char of value) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
  } catch (err) {
    logger.warn({ err, selector }, '[robustType] Failed to type normally, using fallback');
    // Fallback: set value via JS if type failed
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

/** Click a button with common text variants */
async function clickLoginSubmit(page: Page) {
  // Try clicking by text content first
  const clicked = await page.evaluate(() => {
    const variants = ['sign in', 'log in', 'continue', 'submit', 'next'];
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
  
  if (!clicked) {
    // Fallback: try common selectors
    const candidates = [
      'button[type="submit"]',
      'button.sign-in-form__submit-button',
      'button.sign-in-form__submit-btn',
      'button[data-id="sign-in-form__submit-btn"]',
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

/** Check if we're logged in to LinkedIn */
async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const loggedIn = await page.evaluate(() => {
      // Check for various logged-in indicators
      const selectors = [
        '.feed-identity-module',
        '[data-control-name="nav.settings"]',
        '.global-nav__me',
        '.global-nav__primary-items',
        '#global-nav-typeahead',
        '.feed-shared-update-v2',
        '.scaffold-layout__main'
      ];
      
      for (const sel of selectors) {
        if (document.querySelector(sel)) {
          return true;
        }
      }
      
      // Also check if we're NOT on login/signup pages
      const url = window.location.href;
      if (url.includes('/feed') || url.includes('/in/') || url.includes('/mynetwork')) {
        return true;
      }
      
      return false;
    });
    
    return loggedIn;
  } catch {
    return false;
  }
}

/** Ensure critical LinkedIn cookies exist */
async function hasCriticalCookies(page: Page): Promise<boolean> {
  const cookies = await page.cookies();
  const hasLiAt = cookies.some(c => c.name === 'li_at');
  const hasJSESSIONID = cookies.some(c => c.name === 'JSESSIONID');
  
  if (!hasLiAt || !hasJSESSIONID) {
    logger.warn('Missing critical LinkedIn cookies');
    return false;
  }
  return true;
}

// ---------- Enhanced Authentication Flow ----------
export async function authenticateLinkedIn(): Promise<Page> {
  const page = await newPage();
  
  try {
    // Step 1: Visit LinkedIn homepage first (less suspicious than going straight to login)
    logger.info('[li] Visiting LinkedIn homepage first');
    await page.goto('https://www.linkedin.com/', { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    
    // Add human-like behavior
    await humanMouseMovement(page);
    await randomDelay(2000, 4000);
    
    // Step 2: Try loading saved session
    try {
      const loaded = await loadSession(page);
      if (loaded && await hasCriticalCookies(page)) {
        // Refresh page to apply cookies
        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        await randomDelay(2000, 3000);
        
        // Check if we're actually logged in
        if (await isLoggedIn(page)) {
          logger.info('[li] ✅ Authenticated via saved session');
          await ensureFreshSession(page).catch(() => {});
          return page;
        }
        
        logger.warn('[li] Session cookies loaded but not logged in, proceeding to login');
      }
    } catch (err) {
      logger.warn({ err }, '[li] Session load failed, will do fresh login');
    }
    
    // Step 3: Navigate to login page
    if (!env.LINKEDIN_EMAIL || !env.LINKEDIN_PASSWORD) {
      throw new Error('Missing LINKEDIN_EMAIL / LINKEDIN_PASSWORD env vars');
    }
    
    logger.info('[li] Navigating to login page');
    
    // Click "Sign in" button on homepage if it exists
    const signInClicked = await page.evaluate(() => {
      const signInLink = Array.from(document.querySelectorAll('a, button'))
        .find(el => {
          const text = (el.textContent || '').toLowerCase();
          return text.includes('sign in') || text.includes('sign-in');
        });
      
      if (signInLink) {
        (signInLink as HTMLElement).click();
        return true;
      }
      return false;
    });
    
    if (signInClicked) {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    } else {
      // Direct navigation to login
      await page.goto('https://www.linkedin.com/login', { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });
    }
    
    await humanMouseMovement(page);
    await randomDelay(1000, 2000);
    await killCookieBanners(page);
    
    // Step 4: Find and fill login form
    const usernameSelectors = [
      '#username',
      '#session_key',
      'input[name="session_key"]',
      'input[name="username"]',
      'input[id*="username"]',
      'input[id*="session_key"]',
      'input[autocomplete="username"]'
    ];
    
    const passwordSelectors = [
      '#password',
      '#session_password',
      'input[name="session_password"]',
      'input[type="password"]',
      'input[id*="password"]',
      'input[id*="session_password"]',
      'input[autocomplete="current-password"]'
    ];
    
    const userSel = await waitAnySelector(page, usernameSelectors, 30000);
    const passSel = await waitAnySelector(page, passwordSelectors, 30000);
    
    if (!userSel || !passSel) {
      await debugDump(page, 'login-missing-inputs');
      throw new Error(`LinkedIn login inputs not found (userSel=${userSel}, passSel=${passSel})`);
    }
    
    logger.info('[li] Found login form, filling credentials');
    
    // Fill credentials with human-like behavior
    await robustType(page, userSel, env.LINKEDIN_EMAIL);
    await randomDelay(500, 1000);
    await robustType(page, passSel, env.LINKEDIN_PASSWORD);
    await randomDelay(500, 1000);
    
    // Submit form
    await clickLoginSubmit(page);
    
    // Wait for navigation or challenge
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
      sleep(5000) // Sometimes LinkedIn doesn't navigate but loads content dynamically
    ]).catch(() => {});
    
    await randomDelay(2000, 4000);
    
    // Step 5: Handle potential challenges
    const currentUrl = page.url();
    logger.info({ currentUrl }, '[li] Post-login URL');
    
    // Check for verification challenges
    if (currentUrl.includes('/checkpoint/') || currentUrl.includes('/challenge/')) {
      logger.warn('[li] LinkedIn is showing a verification challenge');
      await debugDump(page, 'verification-challenge');
      // You might need to handle 2FA or CAPTCHA here
      // For now, we'll save cookies and hope they work next time
    }
    
    // Save session cookies regardless
    await saveSession(page);
    
    // Verify we're actually logged in
    if (await isLoggedIn(page)) {
      logger.info('[li] ✅ Successfully authenticated');
      await ensureFreshSession(page).catch(() => {});
      return page;
    } else {
      logger.warn('[li] Authentication may have failed, but continuing anyway');
      await debugDump(page, 'auth-uncertain');
      return page;
    }
    
  } catch (err) {
    logger.error({ err }, '[li] Authentication failed');
    await debugDump(page, 'auth-error');
    throw err;
  }
}

// ---------- Scraping Helpers (unchanged) ----------
async function extractExperience(page: Page) {
  await page.waitForSelector('li.pvs-list__paged-list-item', { timeout: 30000 }).catch(() => {});
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
  await page.waitForSelector('.pv-text-details__left-panel, .mt2, h1', { timeout: 30000 }).catch(() => {});
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

// ---------- Main Scrape Function ----------
export async function scrapeLinkedInProfile(profileUrl: string): Promise<any> {
  await enforceRateLimit();

  let page: Page | null = null;
  try {
    logger.info({ profileUrl }, '[li] Starting profile scrape');
    page = await authenticateLinkedIn();
    
    // Add human behavior before navigating to profile
    await humanMouseMovement(page);
    await randomDelay(1000, 2000);

    // Navigate to the profile's experience details
    const detailsUrl = `${profileUrl.replace(/\/$/, '')}/details/experience/`;
    logger.info({ detailsUrl }, '[li] Navigating to experience details');
    
    await page.goto(detailsUrl, { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    
    await humanScroll(page);
    await randomDelay(2000, 3000);
    await debugDump(page, 'experience-page');

    let workHistory = await extractExperience(page).catch(() => []);
    
    if (workHistory.length === 0) {
      logger.warn('[li] No experience found on details page, trying main profile');
      await page.goto(profileUrl, { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });
      await humanScroll(page);
      await expandShowMore(page);
      workHistory = await extractExperience(page).catch(() => []);
    }

    // Navigate to main profile for basic info
    logger.info('[li] Getting basic profile information');
    await page.goto(profileUrl, { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    await randomDelay(1000, 2000);
    await debugDump(page, 'main-profile');

    const basics = await extractBasics(page);

    // Save session after successful scrape
    await saveSession(page);

    return {
      ...basics,
      workHistory,
      education: [],
      skills: [],
      connections: 0
    };
    
  } catch (err) {
    logger.error({ err, profileUrl }, '[li] Scraping failed');
    throw err;
  } finally {
    try { 
      await page?.close(); 
    } catch { /* ignore */ }
  }
}

// ---------- Orchestrators ----------
export async function analyzeLinkedInProfile(linkedinUrl: string) {
  return limiter.schedule(async () => {
    logger.info({ linkedinUrl }, '[li] Profile analysis scheduled');
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