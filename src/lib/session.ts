// src/lib/session.ts
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { Page, CookieParam } from 'puppeteer';
import { logger } from './logger';
import { env } from './env';

type StoredCookies = {
  version: 1;
  savedAt: string;             // ISO timestamp
  lastValidatedAt?: string;    // ISO timestamp
  uaHash?: string;             // to discourage cross-UA reuse
  domainSummary?: Record<string, number>;
  cookies: CookieParam[];
};

const COOKIE_FILE = env.COOKIES_FILE || './linkedin_session.json';
const COOKIE_BAK  = COOKIE_FILE.replace(/(\.json)?$/, '.bak.json');

const COOKIE_SNAPSHOT_URLS = [
  'https://www.linkedin.com',
  'https://www.linkedin.com/feed/',
  'https://www.linkedin.com/mynetwork/',
];

const COOKIE_ALLOWED_DOMAINS = new Set([
  '.linkedin.com',
  'linkedin.com',
  'www.linkedin.com',
  '.www.linkedin.com',
  '.api.linkedin.com',
  'api.linkedin.com',
]);

// Configurable thresholds
const AUTO_REFRESH_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 120 * 60 * 1000); // 2h
const VALIDATION_TIMEOUT_MS   = Number(process.env.SESSION_VALIDATE_TIMEOUT_MS || 120_000); // 2m

/* ───────────────────────── in-process mutex ───────────────────────── */
let lockPromise: Promise<void> | null = null;
let releaseLock: (() => void) | null = null;

async function acquireLock() {
  if (!lockPromise) {
    lockPromise = new Promise<void>((res) => { releaseLock = res; });
    return;
  }
  await lockPromise;
}
function release() {
  if (releaseLock) {
    const rel = releaseLock;
    releaseLock = null;
    lockPromise = null;
    rel();
  }
}

/* ───────────────────────── helpers ───────────────────────── */
const nowIso = () => new Date().toISOString();

function hashUA(ua: string) {
  return crypto.createHash('sha1').update(ua || '').digest('hex').slice(0, 12);
}

async function atomicWrite(file: string, data: string) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  await fsp.writeFile(tmp, data);
  // Backup the old file (best-effort)
  try {
    if (fs.existsSync(file)) {
      await fsp.copyFile(file, COOKIE_BAK);
    }
  } catch { /* ignore */ }
  await fsp.rename(tmp, file);
}

function isExpired(cookie: CookieParam): boolean {
  if (cookie.expires === undefined || cookie.expires === 0) return false;
  const expMs = (cookie.expires || 0) * 1000;
  return expMs > 0 && Date.now() > expMs;
}

function filterAllowed(cookies: CookieParam[]): CookieParam[] {
  return cookies.filter((c) => {
    const d = (c.domain || '').trim();
    if (!d) return false;
    const domain = d.startsWith('.') ? d : d;
    return COOKIE_ALLOWED_DOMAINS.has(domain) || COOKIE_ALLOWED_DOMAINS.has(domain.replace(/^\./, ''));
  });
}

function summarizeDomains(cookies: CookieParam[]) {
  const map: Record<string, number> = {};
  for (const c of cookies) {
    const d = c.domain || '';
    map[d] = (map[d] || 0) + 1;
  }
  return map;
}

/* ───────────────────────── public API ───────────────────────── */

/** Save current LinkedIn cookies from the page to disk (atomically). */
export async function saveSession(page: Page): Promise<void> {
  await acquireLock();
  try {
    // Snapshot from a few authenticated pages to gather all relevant cookies
    const snaps = await Promise.allSettled(COOKIE_SNAPSHOT_URLS.map((u) => page.cookies(u)));

    const collected: CookieParam[] = [];
    for (const r of snaps) {
      if (r.status === 'fulfilled') {
        for (const c of r.value as CookieParam[]) {
          if (c && c.name && c.value) collected.push(c);
        }
      }
    }

    let cookies = filterAllowed(collected).filter((c) => !isExpired(c));

    // Deduplicate by (name|domain|path)
    const dedup = new Map<string, CookieParam>();
    for (const c of cookies) {
      const key = `${c.name}|${c.domain}|${c.path || '/'}`;
      dedup.set(key, c);
    }
    cookies = Array.from(dedup.values());

    const ua = await page.browser().userAgent().catch(() => '');
    const payload: StoredCookies = {
      version: 1,
      savedAt: nowIso(),
      lastValidatedAt: nowIso(),
      uaHash: hashUA(ua),
      domainSummary: summarizeDomains(cookies),
      cookies
    };

    await atomicWrite(COOKIE_FILE, JSON.stringify(payload, null, 2));
    logger.info(
      { path: COOKIE_FILE, count: cookies.length, domains: payload.domainSummary },
      '[session] 💾 Saved'
    );
  } catch (err) {
    logger.error({ err }, '[session] save failed');
  } finally {
    release();
  }
}

/**
 * Load cookies from disk and set them into the page.
 * Also validates by visiting /feed/; if valid, opportunistically re-save.
 * Returns true if session appears authenticated.
 */
export async function loadSession(page: Page): Promise<boolean> {
  await acquireLock();
  try {
    if (!fs.existsSync(COOKIE_FILE)) {
      logger.info({ path: COOKIE_FILE }, '[session] no cookie file');
      return false;
    }

    const raw = await fsp.readFile(COOKIE_FILE, 'utf8').catch(() => '');
    if (!raw) {
      logger.warn({ path: COOKIE_FILE }, '[session] empty cookie file');
      return false;
    }

    let data: StoredCookies | null = null;
    try {
      data = JSON.parse(raw) as StoredCookies;
    } catch (err) {
      logger.error({ err }, '[session] parse error — attempting backup');
      if (fs.existsSync(COOKIE_BAK)) {
        try {
          const bak = await fsp.readFile(COOKIE_BAK, 'utf8');
          data = JSON.parse(bak) as StoredCookies;
          logger.warn('[session] recovered from backup');
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }

    if (!data || !Array.isArray(data.cookies)) return false;

    const cookies = filterAllowed(data.cookies).filter((c) => !isExpired(c));
    if (cookies.length === 0) {
      logger.warn('[session] cookie file has no valid cookies');
      return false;
    }

    // Set cookies (batch to avoid protocol limits)
    const batchSize = 100;
    for (let i = 0; i < cookies.length; i += batchSize) {
      const slice = cookies.slice(i, i + batchSize);
      await page.setCookie(...slice);
    }

    logger.info(
      { path: COOKIE_FILE, count: cookies.length, domains: summarizeDomains(cookies) },
      '[session] ✅ Loaded'
    );

    // Validate; if valid, opportunistically refresh and save
    const ok = await validateSession(page);
    if (ok) {
      await refreshAndSave(page).catch(() => {});
    }
    return ok;
  } finally {
    release();
  }
}

/** Validate session by loading /feed/ and checking we aren’t bounced to login/challenge. */
export async function validateSession(page: Page): Promise<boolean> {
  const url = 'https://www.linkedin.com/feed/';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: VALIDATION_TIMEOUT_MS });
  } catch (err) {
    logger.warn({ err }, '[session] validate: navigation error');
  }

  const current = page.url();
  logger.info({ url: current }, '[session] validate URL');

  const bad = /\/login|\/checkpoint|\/challenge/i.test(current);
  if (bad) {
    logger.warn('[session] validate: looks unauthenticated');
    return false;
  }

  try {
    await page.waitForSelector('nav.global-nav, .feed-shared-update-v2', { timeout: 10_000 });
  } catch { /* ignore */ }

  return true;
}

/**
 * Ensure the session is fresh enough; if older than AUTO_REFRESH_MAX_AGE_MS,
 * revisit a couple of authed pages to refresh cookies, then save.
 */
export async function ensureFreshSession(page: Page): Promise<boolean> {
  let savedAt = 0;
  let lastValidatedAt = 0;

  try {
    const raw = await fsp.readFile(COOKIE_FILE, 'utf8');
    const data = JSON.parse(raw) as StoredCookies;
    savedAt = Date.parse(data.savedAt || '') || 0;
    lastValidatedAt = Date.parse(data.lastValidatedAt || '') || savedAt || 0;
  } catch { /* ignore */ }

  const age = Date.now() - (lastValidatedAt || savedAt || 0);
  if (age < AUTO_REFRESH_MAX_AGE_MS) {
    return true; // fresh enough
  }

  logger.info({ minutesOld: Math.round(age / 60000) }, '[session] auto-refresh threshold reached');

  const ok = await validateSession(page);
  if (!ok) return false;

  await refreshAndSave(page).catch(() => {});
  return true;
}

/* ───────────────────────── internal ───────────────────────── */
async function refreshAndSave(page: Page) {
  try {
    for (const u of COOKIE_SNAPSHOT_URLS) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      } catch { /* ignore */ }
    }
    await saveSession(page);
  } catch (err) {
    logger.warn({ err }, '[session] refreshAndSave failed');
  }
}

/** Manual reset utility (optional) */
export async function clearSessionFile() {
  await acquireLock();
  try {
    if (fs.existsSync(COOKIE_FILE)) await fsp.unlink(COOKIE_FILE).catch(() => {});
    logger.warn({ path: COOKIE_FILE }, '[session] cleared');
  } finally {
    release();
  }
}
