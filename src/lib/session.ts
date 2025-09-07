import type { Page } from 'puppeteer';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { env } from './env';
import { logger } from './logger';

export async function saveSession(page: Page): Promise<void> {
  try {
    const cookies = await page.cookies();
    await fs.writeFile(env.COOKIES_FILE, JSON.stringify(cookies, null, 2), 'utf8');
    logger.info({ path: env.COOKIES_FILE, count: cookies.length }, '[session] ✅ Saved');
  } catch (err) {
    logger.error({ err }, '[session] ❌ Failed to save session');
  }
}

export async function loadSession(page: Page): Promise<boolean> {
  if (!existsSync(env.COOKIES_FILE)) {
    logger.warn('[session] No saved cookies file found');
    return false;
  }
  try {
    const raw = await fs.readFile(env.COOKIES_FILE, 'utf8');
    const cookies = JSON.parse(raw);
    await page.setCookie(...cookies);
    logger.info({ path: env.COOKIES_FILE, count: cookies.length }, '[session] ✅ Loaded');
    return true;
  } catch (err) {
    logger.error({ err }, '[session] ❌ Failed to load session');
    return false;
  }
}
