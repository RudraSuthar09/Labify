/**
 * Environment configuration, validated at startup with zod.
 *
 * Import `env` from here anywhere in the app. If a critical variable is missing
 * or malformed, the process exits with a clear, human-readable error instead of
 * failing later with a cryptic runtime crash.
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    //   3. GOOGLE_CREDENTIALS_JSON — the full service-account JSON as a single
    //      stringified value. Used on hosts (Render, etc.) where uploading a key
    //      file is awkward. At startup we write it to a temp file and point
    //      GOOGLE_APPLICATION_CREDENTIALS at it (see materializeGoogleCredentials).
    GOOGLE_VISION_API_KEY: z.string().optional(),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
    GOOGLE_CREDENTIALS_JSON: z.string().optional(),

    // Placeholder for later — accepted but not yet used.
    DATABASE_URL: z.string().optional(),

    // --- Supabase: scan persistence + image archive -------------------------
    // Both URL and service key must be set to enable persistence/storage; if
    // either is missing the app still verifies scans, just without archiving
    // (getScanStore / getStorageProvider return undefined). The service-role key
    // is server-only — never expose it to the frontend.
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SERVICE_KEY: z.string().optional(),
    // Storage bucket for archived label photos. Has a sensible default so only
    // URL + key are strictly required to turn the feature on. Matches the
    // bucket documented in .env.example.
    SUPABASE_STORAGE_BUCKET: z.string().default('label-scans'),

    // --- Check C: external (Reliance/Geon) serial validation ----------------
    // The authoritative API we POST the verified serial to. Third-party and
    // occasionally flaky, so it is called defensively (timeout + never throws).
    EXTERNAL_VALIDATION_URL: z
      .string()
      .url()
      .default('https://api.geon.world/api/Check_RIL_Barcode'),
    // Hard ceiling on how long a single external call may block a verification.
    EXTERNAL_VALIDATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(8000),
    // Set to "false" to skip the external call entirely (handy for local dev
    // when the API is unreachable). Accepts true/false/1/0/yes/no.
    EXTERNAL_VALIDATION_ENABLED: z
      .string()
      .default('true')
      .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),

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
      !val.GOOGLE_APPLICATION_CREDENTIALS &&
      !val.GOOGLE_CREDENTIALS_JSON
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_VISION_API_KEY'],
        message:
          'When OCR_PROVIDER="google" you must set one of: GOOGLE_VISION_API_KEY ' +
          '(an "AIza..." API key), GOOGLE_APPLICATION_CREDENTIALS (path to a ' +
          'service-account JSON key), or GOOGLE_CREDENTIALS_JSON (the key JSON ' +
          'inline, for cloud hosts). Or use OCR_PROVIDER="mock" for local dev.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Bridge the two credential styles: a file path locally, an inline JSON string
 * in the cloud.
 *
 * If GOOGLE_CREDENTIALS_JSON is set, parse it, write it to a temp file, and
 * point GOOGLE_APPLICATION_CREDENTIALS at that file — the @google-cloud/vision
 * client only knows how to read a file path, so this is what makes an env-var
 * credential work on hosts like Render where uploading a key file is awkward.
 *
 * Runs before validation so the resulting GOOGLE_APPLICATION_CREDENTIALS counts
 * as valid credentials in the schema's superRefine. No-op when the var is unset
 * (local dev keeps using its file path).
 */
function materializeGoogleCredentials(): void {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw || raw.trim() === '') return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      '\n❌ GOOGLE_CREDENTIALS_JSON is set but is not valid JSON.\n' +
        '   Paste the entire service-account key file as a single-line JSON string.\n',
    );
    process.exit(1);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    console.error(
      '\n❌ GOOGLE_CREDENTIALS_JSON did not parse to a JSON object.\n',
    );
    process.exit(1);
  }

  const filePath = path.join(os.tmpdir(), 'labify-gcp-credentials.json');
  try {
    // 0600 so other users on the host can't read the key.
    fs.writeFileSync(filePath, raw, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error(
      `\n❌ Failed to write Google credentials to ${filePath}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Override any inherited path — the inline JSON is the source of truth here.
  process.env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
}

function loadEnv(): Env {
  // Must run before parsing: it may set GOOGLE_APPLICATION_CREDENTIALS, which
  // the schema below treats as valid Google credentials.
  materializeGoogleCredentials();

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
