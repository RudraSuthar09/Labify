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

// Behind Render's (and most PaaS) load balancers, the client IP arrives in the
// X-Forwarded-For header. Trust the first proxy hop so req.ip and the rate
// limiter see the real client address rather than the proxy's.
app.set('trust proxy', 1);

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

// Bind to 0.0.0.0 so the server is reachable from outside the container —
// required by Render (and any PaaS). Binding to localhost would only accept
// connections from within the same host.
const HOST = '0.0.0.0';

const server = app.listen(env.PORT, HOST, () => {
  logger.info(
    { host: HOST, port: env.PORT, ocrProvider: env.OCR_PROVIDER, env: env.NODE_ENV },
    `🚀 LabelVerify backend listening on http://${HOST}:${env.PORT}`,
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
