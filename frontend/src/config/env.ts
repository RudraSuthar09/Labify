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

/**
 * Sentinel used when API_BASE_URL is absent. It is intentionally NOT a real URL
 * so any accidental request fails fast; callers should check `apiConfigured`
 * first and surface a helpful message to the user instead of firing a request.
 */
export const UNCONFIGURED_API_BASE_URL = 'https://api-base-url-not-configured.invalid';

const DEFAULTS = {
  OCR_PROVIDER: 'mock' as OcrProvider,
};

/** Normalises an inlined env value: `undefined` or empty string → `undefined`. */
function clean(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

// IMPORTANT: these must be *static* `process.env.<NAME>` member accesses.
// react-native-dotenv inlines them at build time; a dynamic `process.env[name]`
// is NOT replaced by the babel plugin and would be `undefined` on the device.

// --- API base URL ----------------------------------------------------------

const rawApiBaseUrl = clean(process.env.API_BASE_URL);
const apiConfigured = rawApiBaseUrl !== undefined;

if (!apiConfigured && __DEV__) {
  // eslint-disable-next-line no-console
  console.warn(
    '[env] API_BASE_URL is not set — the app cannot reach the backend. ' +
      'Add it to your .env file (see .env.example). Verification will show a ' +
      'configuration error until this is fixed.',
  );
}

// Normalise: strip any trailing slashes so we can safely append paths.
const apiBaseUrl = (rawApiBaseUrl ?? UNCONFIGURED_API_BASE_URL).replace(/\/+$/, '');

// --- OCR provider (informational) ------------------------------------------

const rawOcrProvider = clean(process.env.OCR_PROVIDER) ?? DEFAULTS.OCR_PROVIDER;
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
  /** False when API_BASE_URL was missing — callers should show a clear error. */
  apiConfigured: boolean;
  /** Which OCR provider the backend talks to. */
  ocrProvider: OcrProvider;
}

export const env: AppEnv = {
  apiBaseUrl,
  apiConfigured,
  ocrProvider: rawOcrProvider as OcrProvider,
};

export default env;
