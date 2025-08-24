import pino from 'pino';
import { env } from './env';

const isProd = env.NODE_ENV === 'production';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined, // cleaner logs: no pid/hostname
  transport: isProd
    ? undefined // JSON logs in prod (Railway)
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          singleLine: false,
          ignore: 'pid,hostname'
        }
      }
});
