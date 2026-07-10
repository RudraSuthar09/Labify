/**
 * GET /api/scans — paginated audit log of past verifications.
 * GET /api/stats — today's verification counts + pass rate.
 *
 * Both return 503 when the scan store isn't configured (no MONGODB_URI).
 * The mobile app treats 503 as "history unavailable, keep scanning" rather than
 * failing hard.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { getScanStore } from '../services/scanStore';
import { HttpError } from '../utils/httpError';

export const scansRouter = Router();

const ListQuerySchema = z.object({
  status: z.enum(['pass', 'fail', 'warning']).optional(),
  cursor: z.string().min(1).optional(),
  // 1..100, defaults to 20. Coerced because query params arrive as strings.
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

scansRouter.get(
  '/api/scans',
  (req: Request, res: Response, next: NextFunction) => {
    const store = getScanStore();
    if (!store) {
      return next(
        new HttpError(
          503,
          'Scan history is not available on this server. Contact your administrator.',
        ),
      );
    }

    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return next(
        new HttpError(400, 'Invalid query', {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        }),
      );
    }

    store
      .listScans(parsed.data)
      .then((page) => res.status(200).json(page))
      .catch(next);
  },
);

scansRouter.get(
  '/api/stats',
  (_req: Request, res: Response, next: NextFunction) => {
    const store = getScanStore();
    if (!store) {
      return next(
        new HttpError(
          503,
          'Stats are not available on this server. Contact your administrator.',
        ),
      );
    }

    store
      .todayStats()
      .then((stats) => res.status(200).json(stats))
      .catch(next);
  },
);

export default scansRouter;
