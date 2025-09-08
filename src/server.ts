// src/server.ts
import express, { Request, Response, NextFunction } from 'express';
import cors, { CorsOptions } from 'cors';
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

/** Safely mask sensitive fields for debug logging */
function scrubBody(body: any) {
  try {
    if (!body || typeof body !== 'object') return body;
    const clone = { ...body };
    for (const key of Object.keys(clone)) {
      const k = key.toLowerCase();
      if (k.includes('password') || k.includes('secret') || k.includes('token')) {
        (clone as any)[key] = '[REDACTED]';
      }
    }
    return clone;
  } catch {
    return {};
  }
}

/** Build permissive-but-safe CORS config with a whitelist + regex for Vercel */
function buildCorsOptions(): CorsOptions {
  // Allow overriding/augmenting via env, comma-separated
  const envOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Known frontends
  const STATIC_WHITELIST = new Set<string>([
    'https://linkedin-digital-recruiter-frontend.vercel.app',
    'https://talentflux.today',
    'https://www.talentflux.today',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    ...envOrigins,
  ]);

  // Accept preview deployments like https://<branch>-<proj>.vercel.app
  const VERCEL_REGEX = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

  const origin: CorsOptions['origin'] = (reqOrigin, callback) => {
    // Non-browser requests (e.g. cURL) have no Origin → allow
    if (!reqOrigin) return callback(null, true);

    if (STATIC_WHITELIST.has(reqOrigin) || VERCEL_REGEX.test(reqOrigin)) {
      return callback(null, true);
    }

    // Optional: log rejected origins to help diagnose
    logger.warn({ origin: reqOrigin }, 'cors.rejected_origin');
    return callback(new Error('CORS: Origin not allowed'));
  };

  return {
    origin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'x-request-id',
      'x-correlation-id',
    ],
    exposedHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400, // cache preflight for a day
    optionsSuccessStatus: 204,
  };
}

export async function createServer() {
  const app = express();

  // Trust proxy (ELB/ALB/Cloudflare) for correct req.ip and secure cookies
  app.set('trust proxy', 1);

  // Security & hardening
  app.use(
    helmet({
      // Keep defaults; disable COEP/COOP that can break EventSource unless you need them
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  );
  app.use(hpp());

  // CORS (global) + explicit preflight for all routes
  const corsOptions = buildCorsOptions();
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  // Body parsing
  app.use(express.json({ limit: '1mb' }));

  // HTTP logging with pino-http
  const httpLoggerOptions: PinoHttpOptions<IncomingMessage, ServerResponse> = {
    autoLogging: { ignore: () => false },
    genReqId: (req: IncomingMessage) =>
      (req.headers['x-request-id'] as string) ||
      (req.headers['x-correlation-id'] as string) ||
      randomUUID(),
    serializers: {
      req(req: IncomingMessage) {
        return {
          method: (req as any).method,
          url: (req as any).url,
          headers: req.headers,
        };
      },
      res(res: ServerResponse) {
        const ex = res as any;
        return {
          statusCode: ex.statusCode,
          headers: typeof ex.getHeaders === 'function' ? ex.getHeaders() : {},
        };
      },
    },
    customSuccessMessage(req, res) {
      return `OK ${(req as any).method} ${(req as any).url} ${(res as any).statusCode}`;
    },
    customErrorMessage(req, res, err) {
      return `ERR ${(req as any).method} ${(req as any).url} ${(res as any).statusCode} - ${err.message}`;
    },
  };
  app.use(pinoHttp(httpLoggerOptions));

  // Timing + request snapshot (after body parser, before routes)
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

  // Rate limiter (proxy-safe)
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) =>
        req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
    }),
  );

  // Health endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // DEBUG: ensure headless browser availability from HTTP
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

  // 🔊 Minimal SSE stream so the frontend's EventSource doesn't 404
  // CORS is already handled globally; keep SSE headers specific to streaming
  app.get('/api/progress/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Flush headers for proxies if available
    (res as any).flushHeaders?.();

    // Initial event
    res.write(`event: hello\ndata: {"ok":true}\n\n`);

    // Heartbeat keepalive (avoid idle timeouts on ALB / proxies)
    const timer = setInterval(() => {
      res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`);
    }, 25_000);

    req.on('close', () => {
      clearInterval(timer);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
  });

  // Mount API routes (ensure your /api/analyze-profile lives under router)
  app.use(router);

  // 404 (after all routes)
  app.use('*', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Centralized error handler (should come last)
  app.use(errorHandler);

  return app;
}
