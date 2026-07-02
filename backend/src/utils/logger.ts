/**
 * Shared pino logger. Pretty, colourised output in development; structured JSON
 * in production (so log aggregators can parse it).
 */
import pino from 'pino';
import { isDev } from '../config/env';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

export default logger;
