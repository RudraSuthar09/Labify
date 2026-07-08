/**
 * Label verification service.
 *
 * POSTs the scanned barcode value and a still photo of the label to the backend,
 * which runs OCR and compares the printed serial against the barcode payload.
 * Returns the backend's structured pass/fail/warning result, or throws a
 * {@link VerificationCallError} carrying a typed, user-presentable reason.
 */
import env from '../config/env';
import type {
  VerificationResult,
  VerificationError,
} from '../types/verification';

/** Shape of the backend's JSON error body: `{ error: { status, message } }`. */
interface BackendErrorBody {
  error?: { status?: number; message?: string };
}

// 45s timeout accommodates the Render free-tier cold start (the service sleeps
// after ~15 min idle and can take 30s+ to wake on the first request).
const REQUEST_TIMEOUT_MS = 45000;

// Health checks are user-initiated from the Settings screen; the operator is
// staring at a spinner, so a shorter timeout gives faster feedback while still
// covering a cold start.
const HEALTH_CHECK_TIMEOUT_MS = 30000;

/**
 * Error thrown by {@link verifyLabel}. Carries a categorised
 * {@link VerificationError} so the UI can render a clean message + retry.
 */
export class VerificationCallError extends Error {
  readonly info: VerificationError;

  constructor(info: VerificationError) {
    super(info.message);
    this.name = 'VerificationCallError';
    this.info = info;
    // Restore prototype chain (TS + transpiled ES5 classes).
    Object.setPrototypeOf(this, VerificationCallError.prototype);
  }
}

/** Pull the backend's human-readable message out of an error response, if any. */
function serverMessage(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const body = data as BackendErrorBody;
    if (body.error && typeof body.error.message === 'string') {
      return body.error.message;
    }
  }
  return undefined;
}

/**
 * Verify a scanned label against its printed serial.
 *
 * @param barcodeValue Decoded barcode/QR payload.
 * @param imageUri     Local `file://` URI of the captured still (from expo-camera).
 *                     Works as-is on both iOS and Android — FormData handles the
 *                     file URI natively, no base64 or path conversion needed.
 * @throws {VerificationCallError} on any network/timeout/server/config failure.
 */
export async function verifyLabel(
  barcodeValue: string,
  imageUri: string,
): Promise<VerificationResult> {
  // Guard: if the app was built without API_BASE_URL, fail with a clear message
  // instead of firing a request at the invalid placeholder host.
  if (!env.apiConfigured) {
    throw new VerificationCallError({
      kind: 'unknown',
      message:
        'App is not configured with a backend URL (API_BASE_URL is missing). ' +
        'Please contact the administrator.',
    });
  }

  const form = new FormData();
  // The `{ uri, name, type }` object is the React Native FormData file shape;
  // TypeScript's DOM FormData typing doesn't know about it, hence `as any`.
  form.append('image', {
    uri: imageUri,
    name: 'label.jpg',
    type: 'image/jpeg',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  form.append('barcodeValue', barcodeValue);
  form.append('labelType', 'battery_pack');

  // Use React Native's native fetch — not axios. RN sets the multipart
  // `Content-Type: multipart/form-data; boundary=...` header itself when the
  // body is a FormData with a file object; axios's pre-set Content-Type
  // clobbers the boundary and Android drops the request as malformed.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(env.apiBaseUrl + '/api/verify', {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === 'AbortError') {
      throw new VerificationCallError({
        kind: 'timeout',
        message:
          'Server took too long to respond. The server may be waking up — try again.',
      });
    }
    throw new VerificationCallError({
      kind: 'network',
      message: 'No connection to the server. Check your internet and try again.',
    });
  }
  clearTimeout(timer);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VerificationCallError({
      kind: 'server',
      message: 'Server returned an invalid response. Please try again.',
    });
  }

  if (!res.ok) {
    throw new VerificationCallError({
      kind: 'server',
      message: serverMessage(body) ?? 'Server error. Please try again.',
    });
  }

  return body as VerificationResult;
}

/**
 * Result of a manual "test connection" ping from the Settings screen.
 * Distinct from {@link VerificationError} because the success shape carries
 * observable data (round-trip latency, server timestamp) that we want to show
 * even on a healthy response.
 */
export type HealthCheckResult =
  | { ok: true; latencyMs: number; timestamp: string | null }
  | { ok: false; error: VerificationError };

/**
 * Ping the backend's `/health` endpoint. Never throws — the failure shape is
 * part of the return type so the caller can render a categorised message
 * without a try/catch.
 */
export async function pingBackend(): Promise<HealthCheckResult> {
  if (!env.apiConfigured) {
    return {
      ok: false,
      error: {
        kind: 'unknown',
        message: 'App is not configured with a backend URL (API_BASE_URL is missing).',
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(env.apiBaseUrl + '/health', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === 'AbortError') {
      return {
        ok: false,
        error: {
          kind: 'timeout',
          message: 'Health check timed out. The server may be waking up — try again.',
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'network',
        message: 'Could not reach the server. Check the URL and your internet connection.',
      },
    };
  }
  clearTimeout(timer);
  const latencyMs = Date.now() - started;

  if (!res.ok) {
    return {
      ok: false,
      error: {
        kind: 'server',
        message: `Server responded with HTTP ${res.status}.`,
      },
    };
  }

  // Best-effort parse of `{ status, timestamp }`. A malformed body still counts
  // as "reachable" — we just skip the timestamp.
  let timestamp: string | null = null;
  try {
    const body = (await res.json()) as { timestamp?: unknown };
    if (typeof body.timestamp === 'string') timestamp = body.timestamp;
  } catch {
    // Non-JSON but 2xx — still reachable. Leave timestamp null.
  }

  return { ok: true, latencyMs, timestamp };
}

export default verifyLabel;
