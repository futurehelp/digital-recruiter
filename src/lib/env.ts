import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  LINKEDIN_EMAIL: z.string().optional(),
  LINKEDIN_PASSWORD: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  FORCE_MOCK_AI: z.string().default('false'),

  // ── Scraper toggles ──────────────────────────────────────────────────────────
  // Force a brand-new LinkedIn login for every analysis (no cookies, no session).
  // This is what you asked for. Set to 'false' only if you later add persistence.
  ALWAYS_FRESH_LOGIN: z
    .string()
    .default('true')
    .transform(v => v === 'true'),

  PUPPETEER_HEADLESS: z.string().default('true'),
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),

  // Timeouts / pacing
  REQUEST_DELAY_MS: z.coerce.number().default(45000),
  PAGE_TIMEOUT_MS: z.coerce.number().default(60000),
  LOGIN_TIMEOUT_MS: z.coerce.number().default(90000),
  ELEMENT_TIMEOUT_MS: z.coerce.number().default(30000)
});

export const env = EnvSchema.parse(process.env);
