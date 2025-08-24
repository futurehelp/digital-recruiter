import { Page } from 'puppeteer';
import fs from 'fs/promises';
import { env } from './env';
import { logger } from './logger';

export async function saveSession(page: Page) {
  try {
    const cookies = await page.cookies();
    await fs.writeFile(env.COOKIES_FILE, JSON.stringify(cookies, null, 2), 'utf8');
    logger.info('Session saved');
  } catch (err) {
    logger.warn({ err }, 'Failed to save session');
  }
}

export async function loadSession(page: Page) {
  const path = env.COOKIES_FILE;
  try {
    const raw = await fs.readFile(path, 'utf8');
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length) {
      await page.setCookie(...cookies);
      logger.info('Session loaded');
    } else {
      throw new Error('No cookies found');
    }
  } catch {
    throw new Error('No valid session found');
  }
}
