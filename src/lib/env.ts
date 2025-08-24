import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  LINKEDIN_EMAIL: z.string().optional(),
  LINKEDIN_PASSWORD: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  FORCE_MOCK_AI: z.string().default('false'),

  COOKIES_FILE: z.string().default('./linkedin_session.json'),

  PUPPETEER_HEADLESS: z.string().default('true'),
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),

  REQUEST_DELAY_MS: z.coerce.number().default(45000),
  PAGE_TIMEOUT_MS: z.coerce.number().default(60000),
  LOGIN_TIMEOUT_MS: z.coerce.number().default(90000),
  ELEMENT_TIMEOUT_MS: z.coerce.number().default(30000)
});

export const env = EnvSchema.parse(process.env);
