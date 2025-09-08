// src/lib/env.ts
import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const Bool = z
  .union([z.string(), z.boolean()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    const s = (v ?? '').toString().trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(s);
  });

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

  // Browser
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(), // leave blank on EC2
  PUPPETEER_HEADLESS: Bool.default(false),          // you run headful on EC2
  HEADFUL: Bool.default(true),                      // default headful
  CHROME_USER_DATA_DIR: z
    .string()
    .default(process.platform === 'linux' ? '/home/ubuntu/chrome-profile-ec2' : './chrome-profile-local'),
  STARTUP_BROWSER_CHECK: Bool.default(true),

  // Xvfb DISPLAY (Linux)
  DISPLAY: z.string().default(':99'),

  // Session persistence
  COOKIES_FILE: z
    .string()
    .default(process.platform === 'linux' ? '/home/ubuntu/linkedin_session.json' : './linkedin_session.json'),

  // Timeouts
  REQUEST_DELAY_MS: z.coerce.number().default(45_000),
  PAGE_TIMEOUT_MS: z.coerce.number().default(120_000),
  LOGIN_TIMEOUT_MS: z.coerce.number().default(90_000),
  ELEMENT_TIMEOUT_MS: z.coerce.number().default(45_000),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  // ---------- Residential Proxy (e.g., Decodo) ----------
  // PROXY_SERVER should be like "http://gate.decodo.com:10001" or "socks5://host:port"
  PROXY_SERVER: z.string().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional()
});

export const env = EnvSchema.parse(process.env);

// Small helpers
function mask(v?: string, keepStart = 4, keepEnd = 2) {
  if (!v) return 'unset';
  if (v.length <= keepStart + keepEnd) return `${v[0]}***`;
  return `${v.slice(0, keepStart)}…${v.slice(-keepEnd)}`;
}

export function safeEnvSummary() {
  return {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,

    OPENAI_MODEL: env.OPENAI_MODEL,
    OPENAI_API_BASE: env.OPENAI_API_BASE,
    OPENAI_API_KEY: mask(env.OPENAI_API_KEY, 6, 4),

    HEADFUL: env.HEADFUL,
    PUPPETEER_HEADLESS: env.PUPPETEER_HEADLESS,
    PUPPETEER_EXECUTABLE_PATH: env.PUPPETEER_EXECUTABLE_PATH || '(auto)',
    CHROME_USER_DATA_DIR: env.CHROME_USER_DATA_DIR,
    DISPLAY: env.DISPLAY,

    COOKIES_FILE: env.COOKIES_FILE,
    STARTUP_BROWSER_CHECK: env.STARTUP_BROWSER_CHECK,
    LOG_LEVEL: env.LOG_LEVEL,

    // Proxy summary (masked)
    PROXY_SERVER: env.PROXY_SERVER || 'unset',
    PROXY_USERNAME: env.PROXY_USERNAME ? mask(env.PROXY_USERNAME, 3, 2) : 'unset',
    PROXY_PASSWORD: env.PROXY_PASSWORD ? mask(env.PROXY_PASSWORD, 2, 2) : 'unset',
    PROXY_ENABLED:
      Boolean(env.PROXY_SERVER) &&
      Boolean(env.PROXY_USERNAME) &&
      Boolean(env.PROXY_PASSWORD)
  };
}
