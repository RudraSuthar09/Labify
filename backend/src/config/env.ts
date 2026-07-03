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

    // Two ways to authenticate the Google Vision client — provide EITHER:
    //
    //   1. GOOGLE_VISION_API_KEY — a simple "AIza..." API key. Quick to set up.
    //   2. GOOGLE_APPLICATION_CREDENTIALS — path to a service-account JSON key.
    //      The @google-cloud/vision client reads this automatically. Preferred
    //      for production (finer-grained IAM, key rotation).
    //
    // When OCR_PROVIDER === 'google', at least one must be present (enforced in
    // superRefine below). The "mock" provider needs neither.
    GOOGLE_VISION_API_KEY: z.string().optional(),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

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
    if (
      val.OCR_PROVIDER === 'google' &&
      !val.GOOGLE_VISION_API_KEY &&
      !val.GOOGLE_APPLICATION_CREDENTIALS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_VISION_API_KEY'],
        message:
          'When OCR_PROVIDER="google" you must set either GOOGLE_VISION_API_KEY ' +
          '(an "AIza..." API key) or GOOGLE_APPLICATION_CREDENTIALS (path to a ' +
          'service-account JSON key). Or use OCR_PROVIDER="mock" for local dev.',
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
