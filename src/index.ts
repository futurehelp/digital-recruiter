import 'dotenv/config';
import { createServer } from './server';
import { env } from './lib/env';
import { logger } from './lib/logger';

async function main() {
  const app = await createServer();
  const port = env.PORT;

  const server = app.listen(port, () => {
    logger.info(
      { port },
      `🚀 LinkedIn Digital Recruiter Backend running on port ${port}`
    );
    logger.info(`📊 Health check: http://localhost:${port}/health`);
  });

  // Graceful shutdown
  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'Received shutdown signal');
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
