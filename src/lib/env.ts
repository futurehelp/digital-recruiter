import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // LinkedIn credentials (used if session missing/expired)
  LINKEDIN_EMAIL: z.string().optional(),
  LINKEDIN_PASSWORD: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_API_BASE: z.string().default('https://api.openai.com/v1'),
  OPENAI_TIMEOUT_MS: z.coerce.number().default(45000),

  // Feature flags
  FORCE_MOCK_AI: z.string().default('false'),

  // Browser
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
  PUPPETEER_HEADLESS: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  HEADFUL: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  CHROME_USER_DATA_DIR: z.string().default('./chrome-profile-local'),
  STARTUP_BROWSER_CHECK: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // Session persistence
  COOKIES_FILE: z.string().default('./linkedin_session.json'),

  // Timeouts
  REQUEST_DELAY_MS: z.coerce.number().default(45000),
  PAGE_TIMEOUT_MS: z.coerce.number().default(60000),
  LOGIN_TIMEOUT_MS: z.coerce.number().default(90000),
  ELEMENT_TIMEOUT_MS: z.coerce.number().default(30000),

  // Logging
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info')
});

export const env = EnvSchema.parse(process.env);

export function safeEnvSummary() {
  const key = env.OPENAI_API_KEY ?? '';
  const masked =
    key.length > 10 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key ? 'set' : 'unset';
  return {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    OPENAI_MODEL: env.OPENAI_MODEL,
    OPENAI_API_BASE: env.OPENAI_API_BASE,
    OPENAI_API_KEY: masked,
    HEADFUL: env.HEADFUL,
    PUPPETEER_HEADLESS: env.PUPPETEER_HEADLESS,
    PUPPETEER_EXECUTABLE_PATH: env.PUPPETEER_EXECUTABLE_PATH || '(auto)',
    CHROME_USER_DATA_DIR: env.CHROME_USER_DATA_DIR,
    COOKIES_FILE: env.COOKIES_FILE,
    STARTUP_BROWSER_CHECK: env.STARTUP_BROWSER_CHECK,
    LOG_LEVEL: env.LOG_LEVEL
  };
}
