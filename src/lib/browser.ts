import path from 'path';
import fs, { existsSync } from 'fs';
import os from 'os';
import Bottleneck from 'bottleneck';
import type { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { env } from './env';
import { logger } from './logger';

puppeteerExtra.use(StealthPlugin());

let browser: Browser | null = null;
let lastRequestTime = 0;

/* ───────────────────────── rate limiter ───────────────────────── */
export const limiter = new Bottleneck({
  minTime: Number.isFinite(env.REQUEST_DELAY_MS) ? env.REQUEST_DELAY_MS : 45_000,
  maxConcurrent: 1
});

/* ───────────────────────── helpers ───────────────────────── */
function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const p of paths) if (p && existsSync(p)) return p;
  return undefined;
}

function resolveExecutablePath(): string | undefined {
  const envPath = env.PUPPETEER_EXECUTABLE_PATH;
  const chosenEnv = firstExisting([envPath]);
  if (chosenEnv) {
    logger.info({ executablePath: chosenEnv }, '[browser] using PUPPETEER_EXECUTABLE_PATH');
    return chosenEnv;
  }
  const linux = firstExisting([
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]);
  if (linux) {
    logger.info({ executablePath: linux }, '[browser] using system Chromium');
    return linux;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const puppeteer = require('puppeteer');
    if (typeof puppeteer.executablePath === 'function') {
      const bundled: string = puppeteer.executablePath();
      if (bundled && existsSync(bundled)) {
        logger.info({ executablePath: bundled }, '[browser] using bundled Chromium');
        return bundled;
      }
    }
  } catch (err) {
    logger.warn({ err }, '[browser] failed to resolve bundled chromium');
  }
  logger.warn('[browser] no executablePath found; letting Puppeteer choose default');
  return undefined;
}

function ensureDir(p: string) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch { /* ignore */ }
}

/**
 * Remove Chrome/Chromium singleton lock files that can be left behind
 * if the same profile was used on another host or a crash occurred.
 */
function unlockChromeProfile(userDataDir: string) {
  try {
    const entries = fs.readdirSync(userDataDir, { withFileTypes: true });
    const targets = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => /^Singleton(Browser|Cookie|Lock|Socket)$/i.test(name));

    for (const name of targets) {
      const full = path.join(userDataDir, name);
      try {
        fs.rmSync(full, { force: true });
        logger.warn({ file: full }, '[browser] removed singleton lock');
      } catch (err) {
        logger.warn({ file: full, err }, '[browser] failed to remove singleton lock');
      }
    }
  } catch (err) {
    logger.debug({ err }, '[browser] unlockChromeProfile skipped');
  }
}

/* ───────────────────────── browser lifecycle ───────────────────────── */
async function innerLaunch(): Promise<Browser> {
  const executablePath = resolveExecutablePath();

  // Force HEADFUL when env.HEADFUL is true; otherwise follow PUPPETEER_HEADLESS
  const headless = env.HEADFUL ? false : !!env.PUPPETEER_HEADLESS;

  // Ensure DISPLAY is set for headful under Xvfb on EC2
  if (!process.env.DISPLAY) {
    process.env.DISPLAY = ':99';
  }

  // User data dir: persist cookies / sessions across runs
  const userDataDir =
    env.CHROME_USER_DATA_DIR && env.CHROME_USER_DATA_DIR.trim()
      ? path.resolve(env.CHROME_USER_DATA_DIR)
      : path.join(os.homedir(), 'chrome-profile-ec2');

  ensureDir(userDataDir);
  // proactively clear stale singleton locks
  unlockChromeProfile(userDataDir);

  const args = [
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',                           // GPU off under Xvfb
    '--disable-web-security',
    '--window-size=1366,768',
    '--lang=en-US,en',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--password-store=basic',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--remote-debugging-port=9222',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check'
  ];

  // Proxy support (Decodo)
  if (env.PROXY_ENABLED && env.PROXY_SERVER) {
    args.push(`--proxy-server=${env.PROXY_SERVER}`);
    if (env.PROXY_BYPASS?.trim()) {
      // Note: this flag is Chromium compatible; values are comma-separated hosts.
      args.push(`--proxy-bypass-list=${env.PROXY_BYPASS}`);
    }
  }

  const opts: PuppeteerLaunchOptions = {
    headless, // will be false on EC2 if HEADFUL=true
    executablePath,
    args,
    defaultViewport: { width: 1366, height: 768 },
    protocolTimeout: Math.max(Number(env.PAGE_TIMEOUT_MS) || 0, 120_000)
  };

  logger.info(
    {
      headful: !headless,
      headless,
      executablePath: executablePath ?? '(auto)',
      userDataDir,
      display: process.env.DISPLAY,
      proxy: {
        enabled: env.PROXY_ENABLED,
        server: env.PROXY_SERVER || 'unset',
        bypass: env.PROXY_BYPASS
      },
      args
    },
    '[browser] launching (EC2 HEADFUL)'
  );

  const b = await puppeteerExtra.launch(opts);

  b.on('disconnected', async () => {
    logger.warn('[browser] disconnected — will relaunch on next request');
    try { browser?.removeAllListeners?.(); } catch {}
    browser = null;
  });

  const version = await b.version().catch(() => 'unknown');
  logger.info({ version }, '[browser] launched');
  return b;
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await innerLaunch();
  } catch (err: any) {
    const msg = String(err?.message || err);
    // Retry once if profile lock error
    if (/profile appears to be in use/i.test(msg)) {
      logger.warn({ err }, '[browser] launch failed due to profile lock — unlocking & retrying once');
      try {
        const dir =
          env.CHROME_USER_DATA_DIR && env.CHROME_USER_DATA_DIR.trim()
            ? path.resolve(env.CHROME_USER_DATA_DIR)
            : path.join(os.homedir(), 'chrome-profile-ec2');
        unlockChromeProfile(dir);
      } catch {/* ignore */}
      return await innerLaunch();
    }
    throw err;
  }
}

export async function getBrowser(): Promise<Browser> {
  if (browser) {
    try {
      await browser.version(); // throws if dead
      return browser;
    } catch (err) {
      logger.warn({ err }, '[browser] cached instance unhealthy; relaunching');
      try {
        browser?.removeAllListeners?.();
        await browser?.close?.();
      } catch { /* ignore */ }
      browser = null;
    }
  }
  browser = await launchBrowser();
  return browser!;
}

/* ───────────────────────── new pages (fingerprint) ───────────────────────── */
export async function newPage(): Promise<Page> {
  try {
    const b = await getBrowser();
    const page = await b.newPage();

    // Apply proxy auth if present
    if (env.PROXY_ENABLED && env.PROXY_USERNAME && env.PROXY_PASSWORD) {
      try {
        await page.authenticate({
          username: env.PROXY_USERNAME,
          password: env.PROXY_PASSWORD
        });
        logger.debug('[browser] proxy credentials applied to page');
      } catch (err) {
        logger.warn({ err }, '[browser] failed to apply proxy credentials');
      }
    }

    // Timeouts tuned for slower EC2 CPUs
    try {
      page.setDefaultNavigationTimeout(Number(env.PAGE_TIMEOUT_MS) || 120_000);
      page.setDefaultTimeout(Number(env.ELEMENT_TIMEOUT_MS) || 45_000);
    } catch { /* ignore */ }

    // Desktop fingerprint (stable UA helps)
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setBypassCSP(true);

    // Add a few “real browser” signals before any site JS executes
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', {
          get: () =>
            [
              { name: 'Chrome PDF Plugin' },
              { name: 'Chrome PDF Viewer' },
              { name: 'Native Client' }
            ] as any
        });

        // Tweak WebGL vendor/renderer
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
          if (param === 37445) return 'Google Inc.'; // UNMASKED_VENDOR_WEBGL
          if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce, Direct3D11)';
          return getParameter.call(this, param);
        };

        // Normalize timezone (optional)
        try {
          // @ts-ignore
          Intl.DateTimeFormat = class extends Intl.DateTimeFormat {
            constructor(locale?: any, options?: any) {
              super(locale, { timeZone: 'America/Los_Angeles', ...(options || {}) });
            }
          };
        } catch {}
      } catch {}
    });

    logger.debug('[browser] new page created');
    return page;
  } catch (err) {
    // One-shot retry: relaunch & try again
    logger.warn({ err }, '[browser] newPage() failed — relaunching and retrying once');
    try {
      browser?.removeAllListeners?.();
      await browser?.close?.();
    } catch { /* ignore */ }
    browser = null;

    const b = await getBrowser();
    const page = await b.newPage();

    if (env.PROXY_ENABLED && env.PROXY_USERNAME && env.PROXY_PASSWORD) {
      try {
        await page.authenticate({
          username: env.PROXY_USERNAME,
          password: env.PROXY_PASSWORD
        });
      } catch {/* ignore */}
    }

    await page.setBypassCSP(true);
    logger.debug('[browser] new page created after relaunch');
    return page;
  }
}

/* ───────────────────────── rate limit enforcement ───────────────────────── */
export async function enforceRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  const delay = Number.isFinite(env.REQUEST_DELAY_MS) ? env.REQUEST_DELAY_MS : 45_000;
  if (elapsed < delay) {
    const wait = delay - elapsed;
    logger.info({ waitMs: wait }, '[browser] rate limiting: waiting…');
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}
