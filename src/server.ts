// server.ts
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

const STATIC_ALLOWED_ORIGINS = [
  'https://linkedin-digital-recruiter-frontend.vercel.app',
  'http://localhost:3000',
];

// Allow rotating *.ngrok-free.app subdomains
function isAllowedOrigin(origin?: string | null) {
  if (!origin) return true; // curl, SSR, server-to-server
  if (STATIC_ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.hostname.endsWith('.ngrok-free.app')) return true;
  } catch {
    // fall through
  }
  return false;
}

const corsOptions: CorsOptions = {
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Request-Id',
  ],
  credentials: true,           // set to false if you don’t send cookies/auth headers
  optionsSuccessStatus: 204,   // safer for legacy browsers
  preflightContinue: false,    // let cors end OPTIONS
};

export async function createServer() {
  const app = express();

  // If behind a proxy/load balancer (ngrok, vercel functions proxying, etc.)
  app.set('trust proxy', 1);

  // --- Security hardening (keep first) ---
  app.use(helmet());
  app.use(hpp());

  // --- CORS must be before any rate limiting / routers ---
  app.use(cors(corsOptions));
  // Explicit preflight for every route
  app.options('*', cors(corsOptions));

  // OPTIONAL: short-circuit OPTIONS before expensive middleware
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // --- Parsers ---
  app.use(express.json({ limit: '1mb' }));

  // --- HTTP logging ---
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

  // --- Request timing + safe body snapshot for debug ---
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
        'request.complete'
      );
    });
    next();
  });

  // --- Rate limiting (after CORS, skip OPTIONS earlier) ---
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) =>
        req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
    })
  );

  // --- Health ---
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // --- Debug: live browser preflight ---
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

  // --- API routes ---
  app.use(router);

  // --- 404 ---
  app.use('*', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // --- Error handler ---
  app.use(errorHandler);

  return app;
}
