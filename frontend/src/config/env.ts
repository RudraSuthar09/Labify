/**
 * Centralised, typed environment configuration.
 *
 * Values come from `.env` (see `.env.example`) and are inlined at build time by
 * react-native-dotenv. Read config from here instead of touching `process.env`
 * directly so we get: a single source of truth, sensible defaults, and a warning
 * when something important is missing.
 */

/** Supported OCR backends. Extend as providers are added. */
export type OcrProvider = 'mock' | 'google-vision' | 'aws-textract';

const DEFAULTS = {
  API_BASE_URL: 'https://api.example.com',
  OCR_PROVIDER: 'mock' as OcrProvider,
};

/**
 * Reads a variable from `process.env`, falling back to a default and warning
 * (in dev) when the variable is absent.
 */
function read(name: 'API_BASE_URL' | 'OCR_PROVIDER', fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        `[env] "${name}" is not set — falling back to "${fallback}". ` +
          `Add it to your .env file (see .env.example).`,
      );
    }
    return fallback;
  }
  return value;
}

const rawOcrProvider = read('OCR_PROVIDER', DEFAULTS.OCR_PROVIDER);
const VALID_PROVIDERS: OcrProvider[] = ['mock', 'google-vision', 'aws-textract'];
if (__DEV__ && !VALID_PROVIDERS.includes(rawOcrProvider as OcrProvider)) {
  // eslint-disable-next-line no-console
  console.warn(
    `[env] OCR_PROVIDER="${rawOcrProvider}" is not a recognised provider ` +
      `(${VALID_PROVIDERS.join(', ')}).`,
  );
}

export interface AppEnv {
  /** Base URL of the verification / OCR backend. No trailing slash. */
  apiBaseUrl: string;
  /** Which OCR provider the app talks to. */
  ocrProvider: OcrProvider;
}

export const env: AppEnv = {
  apiBaseUrl: read('API_BASE_URL', DEFAULTS.API_BASE_URL).replace(/\/+$/, ''),
  ocrProvider: rawOcrProvider as OcrProvider,
};

export default env;
