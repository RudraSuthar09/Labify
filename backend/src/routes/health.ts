import { Router, type Request, type Response } from 'express';

export const healthRouter = Router();

/** GET /health — liveness probe. */
healthRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default healthRouter;
