/**
 * CORS configuration driven by the ALLOWED_ORIGINS env var.
 *
 * Behaviour:
 *   • ALLOWED_ORIGINS unset/empty → allow any origin ("*"). Dev-friendly, and
 *     fine for now while the mobile app talks to the API from arbitrary origins.
 *     TODO: tighten this to an explicit allowlist before real production use.
 *   • ALLOWED_ORIGINS set → only those comma-separated origins are allowed.
 *
 * Requests with no Origin header (curl, native mobile apps, health checks) are
 * always allowed.
 */
import cors, { type CorsOptions } from 'cors';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// env.ALLOWED_ORIGINS is already parsed to string[] (empty when unset).
const allowlist = new Set(env.ALLOWED_ORIGINS);
const allowAll = allowlist.size === 0;

if (allowAll) {
  logger.warn(
    'ALLOWED_ORIGINS is unset — allowing all origins (CORS "*"). ' +
      'Set ALLOWED_ORIGINS to lock this down.',
  );
}

const options: CorsOptions = {
  origin(origin, callback) {
    if (allowAll || !origin || allowlist.has(origin)) {
      callback(null, true);
      return;
    }
    logger.warn({ origin }, 'Blocked CORS request from disallowed origin');
    callback(new Error(`Origin "${origin}" is not allowed by CORS`));
  },
  // Note: when allowing all origins we don't reflect credentials, since "*" and
  // credentialed requests are mutually exclusive per the CORS spec.
  credentials: !allowAll,
};

export const corsMiddleware = cors(options);

export default corsMiddleware;
