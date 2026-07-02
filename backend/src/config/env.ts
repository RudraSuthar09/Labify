/**
 * Environment configuration, validated at startup with zod.
 *
 * Import `env` from here anywhere in the app. If a critical variable is missing
 * or malformed, the process exits with a clear, human-readable error instead of
 * failing later with a cryptic runtime crash.
 */
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),

    PORT: z.coerce.number().int().positive().default(4000),

    OCR_PROVIDER: z.enum(['google', 'mock']).default('google'),

    // Google Cloud Vision API key (the "AIza..." key). Used to call the Vision
    // REST endpoint directly. Required only when OCR_PROVIDER === 'google'
    // (enforced in superRefine).
    GOOGLE_VISION_API_KEY: z.string().optional(),

    // Placeholder for later — accepted but not yet used.
    DATABASE_URL: z.string().optional(),

    // Comma-separated origins → string[]. Empty string means "no origins".
    ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
  })
  .superRefine((val, ctx) => {
    if (val.OCR_PROVIDER === 'google' && !val.GOOGLE_VISION_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_VISION_API_KEY'],
        message:
          'GOOGLE_VISION_API_KEY is required when OCR_PROVIDER="google". ' +
          'Set your Vision API key, or use OCR_PROVIDER="mock" for local dev.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Fail fast and loud — before any server starts listening.
    console.error(
      `\n❌ Invalid environment configuration:\n${details}\n\n` +
        `Check your .env file against .env.example.\n`,
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

export const isDev = env.NODE_ENV === 'development';

export default env;
