/**
 * LabelVerify backend — HTTP server bootstrap.
 *
 * Skeleton only: health check + CORS + logging + JSON error handling.
 * OCR and verification routes are added later.
 */
import express from 'express';
import pinoHttp from 'pino-http';

import { env } from './config/env';
import { logger } from './utils/logger';
import { corsMiddleware } from './middleware/cors';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { healthRouter } from './routes/health';
import { verifyRouter } from './routes/verify';

const app = express();

// Attaches a request-scoped logger at `req.log` and logs each request.
app.use(pinoHttp({ logger }));

app.use(corsMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use(healthRouter);
app.use(verifyRouter);

// 404 for anything unmatched, then the JSON error handler (must be last).
app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, ocrProvider: env.OCR_PROVIDER, env: env.NODE_ENV },
    `🚀 LabelVerify backend listening on http://localhost:${env.PORT}`,
  );
});

// Graceful shutdown.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received — shutting down`);
    server.close(() => process.exit(0));
  });
}

export { app, server };
