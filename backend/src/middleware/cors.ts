/**
 * CORS configuration driven by the ALLOWED_ORIGINS env var.
 *
 * Requests with no Origin header (curl, native mobile apps, health checks) are
 * always allowed. Browser origins must appear in the allowlist.
 */
import cors, { type CorsOptions } from 'cors';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const allowlist = new Set(env.ALLOWED_ORIGINS);

const options: CorsOptions = {
  origin(origin, callback) {
    if (!origin || allowlist.has(origin)) {
      callback(null, true);
      return;
    }
    logger.warn({ origin }, 'Blocked CORS request from disallowed origin');
    callback(new Error(`Origin "${origin}" is not allowed by CORS`));
  },
  credentials: true,
};

export const corsMiddleware = cors(options);

export default corsMiddleware;
