const http = require('http');
const app = require('./src/app');
const connectDB = require('./src/config/db');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const { initSocket } = require('./src/sockets');
const { startDailyReportScheduler } = require('./src/services/scheduler/dailyReportScheduler');

(async () => {
  await connectDB();

  const server = http.createServer(app);
  initSocket(server);

  server.listen(env.port, () => {
    logger.info(`[server] Listening on port ${env.port} (${env.nodeEnv})`);
    if (!env.unipile.apiKey || !env.unipile.accountId) {
      logger.warn('[server] UNIPILE_API_KEY / UNIPILE_ACCOUNT_ID not set — WhatsApp sending is disabled until configured.');
    }
  });

  startDailyReportScheduler();

  // Graceful shutdown
  const shutdown = (signal) => {
    logger.info(`[server] Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      logger.info('[server] Closed remaining connections.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('[server] Unhandled promise rejection:', reason);
  });
})();
