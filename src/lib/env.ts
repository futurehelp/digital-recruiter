import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : def));

const EnvSchema = z.object({
  // App
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // LinkedIn credentials (used if session missing/expired)
  LINKEDIN_EMAIL: z.string().optional(),
  LINKEDIN_PASSWORD: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_API_BASE: z.string().default('https://api.openai.com/v1'),
  OPENAI_TIMEOUT_MS: z.coerce.number().default(45_000),

  // Feature flags
  FORCE_MOCK_AI: z.string().default('false'),

  // Browser / Puppeteer
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
  PUPPETEER_HEADLESS: bool(true),
  HEADFUL: bool(false),
  CHROME_USER_DATA_DIR: z.string().default('./chrome-profile-local'),
  STARTUP_BROWSER_CHECK: bool(true),

  // Session persistence
  COOKIES_FILE: z.string().default('./linkedin_session.json'),

  // Timeouts
  REQUEST_DELAY_MS: z.coerce.number().default(45_000),
  PAGE_TIMEOUT_MS: z.coerce.number().default(60_000),
  LOGIN_TIMEOUT_MS: z.coerce.number().default(90_000),
  ELEMENT_TIMEOUT_MS: z.coerce.number().default(30_000),

  // Logging
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),

  // Proxy (Decodo)
  PROXY_ENABLED: bool(false),
  PROXY_SERVER: z.string().optional(), // e.g. "http://gate.decodo.com:10001"
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),
  PROXY_BYPASS: z.string().default('localhost,127.0.0.1')
});

export const env = EnvSchema.parse(process.env);

export function safeEnvSummary() {
  const mask = (val?: string) => {
    if (!val) return 'unset';
    if (val.length <= 6) return 'set';
    return `${val.slice(0, 3)}…${val.slice(-2)}`;
  };

  return {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,

    OPENAI_MODEL: env.OPENAI_MODEL,
    OPENAI_API_BASE: env.OPENAI_API_BASE,
    OPENAI_API_KEY: mask(env.OPENAI_API_KEY),

    HEADFUL: env.HEADFUL,
    PUPPETEER_HEADLESS: env.PUPPETEER_HEADLESS,
    PUPPETEER_EXECUTABLE_PATH: env.PUPPETEER_EXECUTABLE_PATH || '(auto)',
    CHROME_USER_DATA_DIR: env.CHROME_USER_DATA_DIR,
    COOKIES_FILE: env.COOKIES_FILE,

    STARTUP_BROWSER_CHECK: env.STARTUP_BROWSER_CHECK,
    LOG_LEVEL: env.LOG_LEVEL,

    PROXY_ENABLED: env.PROXY_ENABLED,
    PROXY_SERVER: env.PROXY_SERVER || 'unset',
    PROXY_USERNAME: mask(env.PROXY_USERNAME),
    PROXY_PASSWORD: mask(env.PROXY_PASSWORD),
    PROXY_BYPASS: env.PROXY_BYPASS
  };
}
