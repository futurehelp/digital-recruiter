import { createServer } from './server';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { getBrowser, newPage } from './lib/browser';

async function startupBrowserPreflight() {
  if (!env.STARTUP_BROWSER_CHECK) {
    logger.info('[startup] browser preflight disabled');
    return;
  }
  try {
    logger.info('[startup] running browser preflight…');
    const browser = await getBrowser();
    const version = await browser.version().catch(() => 'unknown');
    const page = await newPage();
    await page.goto('about:blank').catch(() => {});
    const ua = await page.evaluate(() => navigator.userAgent).catch(() => 'n/a');
    await page.close().catch(() => {});
    logger.info({ version, ua }, '[startup] browser preflight OK');
  } catch (err) {
    logger.error({ err }, '[startup] browser preflight failed (continuing)');
  }
}

async function main() {
  try {
    const app = await createServer();
    const server = app.listen(env.PORT, () => {
      logger.info(
        {
          env: env.NODE_ENV,
          port: env.PORT,
          headful: env.HEADFUL,
          headless: env.PUPPETEER_HEADLESS,
          execPath: process.env.PUPPETEER_EXECUTABLE_PATH || '(auto)',
          userDataDir: env.CHROME_USER_DATA_DIR,
          logLevel: env.LOG_LEVEL
        },
        '🚀 LinkedIn Digital Recruiter Backend listening'
      );
      logger.info(`📊 Health check: http://localhost:${env.PORT}/health`);
    });

    // Run the browser preflight in background (so the server is ready quickly)
    setImmediate(() => {
      startupBrowserPreflight().catch((err) =>
        logger.error({ err }, '[startup] preflight threw')
      );
    });

    // Process-level guards
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
  } catch (err) {
    logger.fatal({ err }, '[startup] failed to start server');
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, '[startup] fatal');
  process.exit(1);
});
