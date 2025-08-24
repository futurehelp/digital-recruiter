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

/**
 * Safe pretty-printer for logged bodies
 */
function safeBody(bodyStr?: string) {
  if (!bodyStr) return {};
  try {
    const obj = JSON.parse(bodyStr);
    if (obj && typeof obj === 'object') {
      if ('password' in obj) (obj as any).password = '[REDACTED]';
      return obj;
    }
  } catch {
    // ignore parse errors
  }
  return {};
}

export async function createServer() {
  const app = express();

  // Security + parsing
  app.use(helmet());
  app.use(hpp());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  // ---- pino-http request/response logging (typesafe) ----
  // NOTE: Do NOT pass our custom logger instance here to avoid generic type mismatches with pino-http.
  // Let pino-http create its own internal logger; we’ll still use our `logger` elsewhere.
  const httpLoggerOptions: PinoHttpOptions<IncomingMessage, ServerResponse> = {
    autoLogging: {
      // Predicate form required by typings
      ignore: (_req: IncomingMessage): boolean => false
    },

    genReqId: (req: IncomingMessage, _res: ServerResponse) => {
      const headers = req.headers || {};
      const existing =
        (headers['x-request-id'] as string) ||
        (headers['x-correlation-id'] as string);
      // Must return a ReqId (string|number|symbol)
      return existing || randomUUID();
    },

    serializers: {
      req(req: IncomingMessage) {
        const out: Record<string, unknown> = {
          method: (req as any).method,
          url: (req as any).url,
          headers: req.headers
        };
        const body = (req as any).body;
        if (body && typeof body === 'object') {
          const clone = { ...body };
          if ('password' in clone) (clone as any).password = '[REDACTED]';
          out.body = clone;
        }
        return out;
      },
      res(res: ServerResponse) {
        const ex = res as any;
        return {
          statusCode: ex.statusCode,
          headers:
            typeof ex.getHeaders === 'function' ? ex.getHeaders() : ({} as Record<string, unknown>)
        };
      }
    },

    customSuccessMessage(req: IncomingMessage, res: ServerResponse): string {
      const method = (req as any).method;
      const url = (req as any).url;
      const status = (res as any).statusCode;
      return `OK ${method} ${url} ${status}`;
    },

    customErrorMessage(req: IncomingMessage, res: ServerResponse, err: Error): string {
      const method = (req as any).method;
      const url = (req as any).url;
      const status = (res as any).statusCode;
      return `ERR ${method} ${url} ${status} - ${err.message}`;
    },

    quietReqLogger: false
  };

  app.use(pinoHttp(httpLoggerOptions));

  // Extra detailed timing + body snapshot using our app-level logger
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    (req as any)._bodySnapshot = JSON.stringify(req.body ?? {});
    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1_000_000;
      logger.debug(
        {
          method: req.method,
          path: req.originalUrl || req.url,
          status: res.statusCode,
          durationMs: Number(ms.toFixed(2)),
          requestBody: safeBody((req as any)._bodySnapshot),
          responseHeaders: res.getHeaders()
        },
        'request.complete'
      );
    });
    next();
  });

  // Basic rate limit (per IP)
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many requests from this IP, try again later.'
    })
  );

  // Routes
  app.use(router);

  // 404
  app.use('*', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}
