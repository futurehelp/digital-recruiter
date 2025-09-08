import { createServer } from './server';
import { env, safeEnvSummary } from './lib/env';
import { logger } from './lib/logger';
import { getBrowser, newPage } from './lib/browser';

async function startupBrowserPreflight() {
  if (!env.STARTUP_BROWSER_CHECK) {
    logger.info('[startup] browser preflight disabled');
    return;
  }
  try {
    logger.info('[startup] preflight: launching Chromium…');
    const browser = await getBrowser();
    const version = await browser.version().catch(() => 'unknown');
    const page = await newPage();
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
    const ua = await page.evaluate(() => navigator.userAgent).catch(() => 'n/a');
    await page.close().catch(() => {});
    logger.info({ version, ua }, '[startup] preflight: OK');
  } catch (err) {
    logger.error({ err }, '[startup] preflight: FAILED (continuing)');
  }
}

async function main() {
  logger.info(safeEnvSummary(), '[startup] Environment summary');

  // ultra-early stdout (helps when logger transport is misconfigured)
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: 'info',
      msg: '[startup] booting server',
      env: env.NODE_ENV,
      port: env.PORT,
      headful: env.HEADFUL,
      headless: env.PUPPETEER_HEADLESS,
      execPath: env.PUPPETEER_EXECUTABLE_PATH || '(auto)',
      userDataDir: env.CHROME_USER_DATA_DIR,
      logLevel: env.LOG_LEVEL,
      proxy: {
        enabled: env.PROXY_ENABLED,
        server: env.PROXY_SERVER || 'unset'
      }
    })
  );

  const app = await createServer();

  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        env: env.NODE_ENV,
        port: env.PORT,
        headful: env.HEADFUL,
        headless: env.PUPPETEER_HEADLESS,
        execPath: env.PUPPETEER_EXECUTABLE_PATH || '(auto)',
        userDataDir: env.CHROME_USER_DATA_DIR,
        logLevel: env.LOG_LEVEL,
        openaiModel: env.OPENAI_MODEL,
        proxy: {
          enabled: env.PROXY_ENABLED,
          server: env.PROXY_SERVER || 'unset',
          bypass: env.PROXY_BYPASS
        }
      },
      '🚀 Backend listening'
    );
    logger.info(`📊 Health: http://localhost:${env.PORT}/health`);
  });

  // don’t block the listener; do browser preflight after boot
  setImmediate(() => {
    startupBrowserPreflight().catch((err) =>
      logger.error({ err }, '[startup] preflight threw')
    );
  });

  process.on('unhandledRejection', (reason: any) => {
    logger.error({ reason }, '[process] unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, '[process] uncaughtException');
  });
  process.on('SIGTERM', () => {
    logger.warn('[process] SIGTERM received; shutting down');
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    logger.warn('[process] SIGINT received; shutting down');
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'fatal', msg: '[startup] fatal', err: String(err) }));
  logger.fatal({ err }, '[startup] fatal');
  process.exit(1);
});
