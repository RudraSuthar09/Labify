/**
 * Central error handling. Guarantees every error leaves the API as JSON — never
 * an HTML error page — and logs it with the request-scoped logger.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../utils/httpError';
import { logger } from '../utils/logger';
import { isDev } from '../config/env';

/** 404 handler for unmatched routes. Placed after all routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      status: 404,
      message: `Cannot ${req.method} ${req.originalUrl}`,
    },
  });
}

/** Error-handling middleware. Must keep all four args for Express to detect it. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let details: unknown;

  if (err instanceof HttpError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = 400;
    message = 'Validation failed';
    details = err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
  } else if (err instanceof Error) {
    message = err.message || message;
  }

  const log = (req as Request & { log?: typeof logger }).log ?? logger;
  if (statusCode >= 500) {
    log.error({ err }, 'Unhandled error');
  } else {
    log.warn({ err: message, statusCode }, 'Request error');
  }

  res.status(statusCode).json({
    error: {
      status: statusCode,
      message,
      ...(details !== undefined ? { details } : {}),
      // Only leak stack traces in development.
      ...(isDev && err instanceof Error ? { stack: err.stack } : {}),
    },
  });
}
