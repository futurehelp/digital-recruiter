// src/server.ts
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import rateLimit from 'express-rate-limit';
import 'express-async-errors';
import pinoHttp, { type Options as PinoHttpOptions } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { router } from './routes';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './lib/logger';
import { getBrowser, newPage } from './lib/browser';

function scrubBody(body: any) {
  try {
    if (!body || typeof body !== 'object') return body;
    const clone = { ...body };
    if ('password' in clone) (clone as any).password = '[REDACTED]';
    return clone;
  } catch {
    return {};
  }
}

export async function createServer() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    helmet({
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  );
  app.use(hpp());

  // 🚨 POC CORS: allow ALL origins (not safe for prod)
  app.use(cors({ origin: '*', credentials: false }));
  app.options('*', cors({ origin: '*', credentials: false }));

  app.use(express.json({ limit: '1mb' }));

  const httpLoggerOptions: PinoHttpOptions<IncomingMessage, ServerResponse> = {
    autoLogging: { ignore: () => false },
    genReqId: (req: IncomingMessage) =>
      (req.headers['x-request-id'] as string) ||
      (req.headers['x-correlation-id'] as string) ||
      randomUUID(),
  };
  app.use(pinoHttp(httpLoggerOptions));

  // Timing + body snapshot
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const snap = JSON.stringify(req.body ?? {});
    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1_000_000;
      logger.debug(
        {
          method: req.method,
          path: req.originalUrl || req.url,
          status: res.statusCode,
          durationMs: Number(ms.toFixed(2)),
          requestBody: scrubBody(JSON.parse(snap)),
          responseHeaders: res.getHeaders(),
        },
        'request.complete',
      );
    });
    next();
  });

  // Rate limiter
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Health endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Debug browser preflight
  app.get('/debug/preflight', async (_req, res, next) => {
    try {
      const browser = await getBrowser();
      const version = await browser.version().catch(() => 'unknown');
      const page = await newPage();
      await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
      const ua = await page.evaluate(() => navigator.userAgent).catch(() => 'n/a');
      await page.close().catch(() => {});
      res.json({
        ok: true,
        version,
        ua,
        headful: process.env.HEADFUL,
        exec: process.env.PUPPETEER_EXECUTABLE_PATH,
      });
    } catch (err) {
      next(err);
    }
  });

  // SSE stream
  app.get('/api/progress/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    (res as any).flushHeaders?.();

    res.write(`event: hello\ndata: {"ok":true}\n\n`);

    const timer = setInterval(() => {
      res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`);
    }, 25000);

    req.on('close', () => {
      clearInterval(timer);
      try {
        res.end();
      } catch {}
    });
  });

  // Your routes
  app.use(router);

  // 404
  app.use('*', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}
