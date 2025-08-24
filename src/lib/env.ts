import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Credentials
  LINKEDIN_EMAIL: z.string().optional(),
  LINKEDIN_PASSWORD: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_API_BASE: z.string().default('https://api.openai.com/v1'),
  OPENAI_ORG_ID: z.string().optional(),
  OPENAI_PROJECT_ID: z.string().optional(),
  OPENAI_TIMEOUT_MS: z.coerce.number().default(45000),

  // Feature flags
  FORCE_MOCK_AI: z.string().default('false'),

  // Browser toggles
  PUPPETEER_HEADLESS: z.string().default('true'),
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
  HEADFUL: z.string().default('false').transform((v) => v === 'true'),
  CHROME_USER_DATA_DIR: z.string().default('/tmp/chrome-data'),
  STARTUP_BROWSER_CHECK: z.string().default('true').transform((v) => v === 'true'),

  // Timeouts / pacing
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

// Quick, safe summary to print on boot
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
    OPENAI_ORG_ID: env.OPENAI_ORG_ID ? 'set' : 'unset',
    OPENAI_PROJECT_ID: env.OPENAI_PROJECT_ID ? 'set' : 'unset',
    HEADFUL: env.HEADFUL,
    PUPPETEER_HEADLESS: env.PUPPETEER_HEADLESS,
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '(auto)',
    CHROME_USER_DATA_DIR: env.CHROME_USER_DATA_DIR,
    LOG_LEVEL: env.LOG_LEVEL
  };
}
