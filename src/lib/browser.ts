// src/lib/browser.ts
import path from 'path';
import fs, { existsSync } from 'fs';
import os from 'os';
import Bottleneck from 'bottleneck';
import type { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { env } from './env';
import { logger } from './logger';

// Use stealth plugin with all evasions
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('iframe.contentWindow');
stealth.enabledEvasions.delete('media.codecs');
puppeteerExtra.use(stealth);

let browser: Browser | null = null;
let lastRequestTime = 0;

/* ───────────────────────── rate limiter ───────────────────────── */
export const limiter = new Bottleneck({
  minTime: Number.isFinite(env.REQUEST_DELAY_MS) ? env.REQUEST_DELAY_MS : 45_000,
  maxConcurrent: 1,
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
    '/usr/bin/chromium-browser',
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
  } catch {
    /* ignore */
  }
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
      .filter((name) => /^(Singleton|\.com\.google\.Chrome)(Browser|Cookie|Lock|Socket)/i.test(name));

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

/** Build a realistic UA that matches the actual Chrome version */
async function computeRealisticUA(b: Browser): Promise<string> {
  let major = 120;
  try {
    const v = await b.version();
    const m = v.match(/Chrome\/(\d+)/i);
    if (m) major = parseInt(m[1], 10);
  } catch {
    /* ignore */
  }

  // Use Windows UA - less suspicious for LinkedIn
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/* ───────────────────────── browser lifecycle ───────────────────────── */
async function innerLaunch(): Promise<Browser> {
  const executablePath = resolveExecutablePath();

  // Force HEADFUL when env.HEADFUL is true
  const headless = env.HEADFUL ? false : !!env.PUPPETEER_HEADLESS;

  // Ensure DISPLAY is set for headful under Xvfb on EC2
  if (!headless && !process.env.DISPLAY) {
    process.env.DISPLAY = ':99';
    logger.info('[browser] Set DISPLAY=:99 for headful mode');
  }

  // User data dir: persist cookies / sessions across runs
  const userDataDir =
    env.CHROME_USER_DATA_DIR && env.CHROME_USER_DATA_DIR.trim()
      ? path.resolve(env.CHROME_USER_DATA_DIR)
      : path.join(os.homedir(), 'chrome-profile-ec2');

  ensureDir(userDataDir);
  // proactively clear stale singleton locks
  unlockChromeProfile(userDataDir);

  // CRITICAL: These args are tuned for LinkedIn anti-detection + EC2 memory constraints
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',

    // Required for EC2
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',

    // Memory optimization
    '--single-process',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--max_old_space_size=512',

    // Display settings
    '--window-size=1920,1080',
    '--start-maximized',
    '--disable-gpu',
    '--disable-software-rasterizer',

    // Critical anti-detection flags
    '--disable-blink-features=AutomationControlled',
    '--exclude-switches=enable-automation',
    '--disable-infobars',
    '--disable-features=site-per-process,IsolateOrigins',
    '--disable-site-isolation-trials',
    '--flag-switches-begin',
    '--flag-switches-end',

    // Language and locale
    '--lang=en-US,en',
    '--accept-lang=en-US,en;q=0.9',

    // Permissions and features
    '--allow-running-insecure-content',
    '--disable-features=UserAgentClientHint,ImprovedCookieControls,RendererCodeIntegrity,FlashDeprecationWarning,EnablePasswordsAccountStorage,ChromeWhatsNewUI',
    '--enable-features=NetworkService,NetworkServiceInProcess',

    // Audio/Video fake devices
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',

    // Other
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-breakpad',
    '--disable-hang-monitor',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-pings',
    '--autoplay-policy=no-user-gesture-required',
  ];

  // Proxy support
  if (env.PROXY_ENABLED && env.PROXY_SERVER) {
    args.push(`--proxy-server=${env.PROXY_SERVER}`);
    if (env.PROXY_BYPASS?.trim()) {
      args.push(`--proxy-bypass-list=${env.PROXY_BYPASS}`);
    }
  }

  const opts: PuppeteerLaunchOptions = {
    headless,
    executablePath,
    args,
    defaultViewport: null, // Use full window
    ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection'],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    protocolTimeout: Math.max(Number(env.PAGE_TIMEOUT_MS) || 0, 180_000),
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
      },
    },
    '[browser] launching (EC2 HEADFUL with enhanced stealth)',
  );

  const b = await puppeteerExtra.launch(opts);

  b.on('disconnected', async () => {
    logger.warn('[browser] disconnected — will relaunch on next request');
    try {
      browser?.removeAllListeners?.();
    } catch {}
    browser = null;
  });

  const version = await b.version().catch(() => 'unknown');
  logger.info({ version }, '[browser] launched successfully');

  return b;
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await innerLaunch();
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/profile appears to be in use/i.test(msg) || /lock file/i.test(msg)) {
      logger.warn({ err }, '[browser] launch failed due to profile lock — unlocking & retrying');
      try {
        const dir =
          env.CHROME_USER_DATA_DIR && env.CHROME_USER_DATA_DIR.trim()
            ? path.resolve(env.CHROME_USER_DATA_DIR)
            : path.join(os.homedir(), 'chrome-profile-ec2');
        unlockChromeProfile(dir);
        // Also try to kill any hanging Chrome processes
        const { exec } = require('child_process');
        await new Promise((resolve) => {
          exec('pkill -f "chrome|chromium"', () => resolve(null));
        });
        await new Promise((r) => setTimeout(r, 2000));
      } catch {
        /* ignore */
      }
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
      } catch {
        /* ignore */
      }
      browser = null;
    }
  }
  browser = await launchBrowser();
  return browser!;
}

/* ───────────────────────── new pages with maximum stealth ───────────────────────── */
export async function newPage(): Promise<Page> {
  try {
    const b = await getBrowser();
    const page = await b.newPage();

    // Apply proxy auth if present
    if (env.PROXY_ENABLED && env.PROXY_USERNAME && env.PROXY_PASSWORD) {
      try {
        await page.authenticate({
          username: env.PROXY_USERNAME,
          password: env.PROXY_PASSWORD,
        });
        logger.debug('[browser] proxy credentials applied to page');
      } catch (err) {
        logger.warn({ err }, '[browser] failed to apply proxy credentials');
      }
    }

    // Timeouts tuned for slower EC2 CPUs
    try {
      page.setDefaultNavigationTimeout(Number(env.PAGE_TIMEOUT_MS) || 180_000);
      page.setDefaultTimeout(Number(env.ELEMENT_TIMEOUT_MS) || 60_000);
    } catch {
      /* ignore */
    }

    // Use Windows UA for better LinkedIn compatibility
    const windowsUA = await computeRealisticUA(b);
    await page.setUserAgent(windowsUA);

    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    // Set realistic headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    });

    // CRITICAL: Maximum stealth evasions — runs in page context
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver property completely
      try {
        // @ts-ignore
        const newProto = navigator.__proto__;
        // @ts-ignore
        delete newProto.webdriver;
        // @ts-ignore
        navigator.__proto__ = newProto;
      } catch {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      }

      // Ensure window.chrome exists
      // @ts-ignore
      if (!window.chrome) {
        // @ts-ignore
        window.chrome = {
          runtime: {
            connect: () => ({
              disconnect: () => {},
              onDisconnect: { addListener: () => {} },
              onMessage: { addListener: () => {} },
              postMessage: () => {},
            }),
            sendMessage: () => {},
            onMessage: { addListener: () => {} },
          },
          loadTimes: function () {
            return {
              commitLoadTime: Date.now() / 1000,
              connectionInfo: 'h2',
              finishDocumentLoadTime: Date.now() / 1000,
              finishLoadTime: Date.now() / 1000,
              firstPaintAfterLoadTime: 0,
              firstPaintTime: Date.now() / 1000,
              navigationType: 'Other',
              npnNegotiatedProtocol: 'h2',
              requestTime: Date.now() / 1000,
              startLoadTime: Date.now() / 1000,
              wasAlternateProtocolAvailable: false,
              wasFetchedViaSpdy: true,
              wasNpnNegotiated: true,
            };
          },
          csi: function () {
            return { onloadT: Date.now(), pageT: Date.now(), startE: Date.now() - 1000 };
          },
          app: {
            isInstalled: false,
            getDetails: () => null,
            getIsInstalled: () => false,
            installState: () => ({
              DISABLED: 'disabled',
              INSTALLED: 'installed',
              NOT_INSTALLED: 'not_installed',
            }),
            runningState: () => ({
              CANNOT_RUN: 'cannot_run',
              READY_TO_RUN: 'ready_to_run',
              RUNNING: 'running',
            }),
          },
        };
      }

      // Proper permissions handling
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        // @ts-ignore
        window.navigator.permissions.query = (parameters: any) =>
          parameters.name === 'notifications'
            // Use any here so TS in Node context doesn't require DOM PermissionStatus shape
            ? Promise.resolve({ state: 'default' } as any)
            : originalQuery(parameters);
      }

      // Realistic plugins for Windows Chrome
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const arr: any = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: 'Native Client Executable' },
          ];
          Object.setPrototypeOf(arr, PluginArray.prototype);
          arr.item = function (i: number) {
            return this[i];
          };
          arr.namedItem = function (name: string) {
            return this.find((p: any) => p.name === name);
          };
          arr.refresh = function () {
            return undefined;
          };
          return arr;
        },
      });

      // Realistic window properties
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'language', { get: () => 'en-US' });

      // WebGL vendor strings (NVIDIA common on Windows)
      try {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param: number) {
          if (param === 37445) return 'Google Inc. (NVIDIA)';
          if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)';
          // @ts-ignore
          return getParameter.apply(this, [param]);
        };

        const getParameter2 = (WebGL2RenderingContext as any)?.prototype?.getParameter;
        if (getParameter2) {
          (WebGL2RenderingContext as any).prototype.getParameter = function (param: number) {
            if (param === 37445) return 'Google Inc. (NVIDIA)';
            if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)';
            // @ts-ignore
            return getParameter2.apply(this, [param]);
          };
        }
      } catch {}

      // Battery API (plugged in on desktop)
      if ('getBattery' in navigator) {
        // @ts-ignore
        navigator.getBattery = () =>
          Promise.resolve({
            charging: true,
            chargingTime: 0,
            dischargingTime: Infinity,
            level: 1,
            addEventListener: () => {},
            removeEventListener: () => {},
          });
      }

      // Fix toString methods to appear native
      try {
        const nativeToStringFunctionString = Error.toString().replace(/Error/g, 'toString');
        const oldCall = Function.prototype.call;
        // Loosen types for Node/TS
        (Function.prototype as any).call = function (this: any, ...args: any[]) {
          if (args[0] && (args[0] as any).toString === nativeToStringFunctionString) {
            return nativeToStringFunctionString;
          }
          return (oldCall as any).apply(this, args as any);
        };
      } catch {}

      // Console.debug fix
      try {
        const consoleDebug = console.debug;
        // @ts-ignore
        console.debug = function (...args: any[]) {
          if (args[0] && args[0].includes && args[0].includes('function const')) return;
          return consoleDebug.apply(console, args as any);
        };
      } catch {}

      // Remove automation indicators
      [
        '__webdriver_evaluate',
        '__selenium_evaluate',
        '__webdriver_script_function',
        '__webdriver_script_func',
        '__webdriver_script_fn',
        '__fxdriver_evaluate',
        '__driver_unwrapped',
        '__webdriver_unwrapped',
        '__driver_evaluate',
        '__selenium_unwrapped',
        '__fxdriver_unwrapped',
      ].forEach((prop) => {
        // @ts-ignore
        delete (window as any)[prop];
        // @ts-ignore
        delete (document as any)[prop];
      });
    }); // <-- end evaluateOnNewDocument

    // Random mouse movement on first page load (Node context)
    page.once('load', async () => {
      try {
        await page.mouse.move(100 + Math.random() * 700, 100 + Math.random() * 500);
      } catch {}
    });

    logger.debug('[browser] new stealth page created');
    return page;
  } catch (err) {
    logger.error({ err }, '[browser] newPage() failed — retrying with relaunch');
    try {
      browser?.removeAllListeners?.();
      await browser?.close?.();
    } catch {
      /* ignore */
    }
    browser = null;

    const b = await getBrowser();
    const page = await b.newPage();

    if (env.PROXY_ENABLED && env.PROXY_USERNAME && env.PROXY_PASSWORD) {
      try {
        await page.authenticate({
          username: env.PROXY_USERNAME,
          password: env.PROXY_PASSWORD,
        });
      } catch {
        /* ignore */
      }
    }

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

/* ───────────────────────── cleanup helper ───────────────────────── */
export async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
      browser = null;
      logger.info('[browser] closed successfully');
    } catch (err) {
      logger.error({ err }, '[browser] error closing');
    }
  }
}
