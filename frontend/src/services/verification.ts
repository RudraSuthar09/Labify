/**
 * Label verification service.
 *
 * POSTs the scanned barcode value and a still photo of the label to the backend,
 * which runs OCR and compares the printed serial against the barcode payload.
 * Returns the backend's structured pass/fail/warning result, or throws a
 * {@link VerificationCallError} carrying a typed, user-presentable reason.
 */
import axios, { AxiosError } from 'axios';

import env from '../config/env';
import type {
  VerificationResult,
  VerificationError,
} from '../types/verification';

/** Shape of the backend's JSON error body: `{ error: { status, message } }`. */
interface BackendErrorBody {
  error?: { status?: number; message?: string };
}

/**
 * Error thrown by {@link verifyLabel}. Carries a categorised
 * {@link VerificationError} so the UI can render a clean message + retry without
 * inspecting axios internals.
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

// One axios instance for all verification calls. 45s timeout accommodates the
// Render free-tier cold start (the service sleeps after ~15 min idle and can
// take 30s+ to wake on the first request).
const client = axios.create({
  baseURL: env.apiBaseUrl,
  timeout: 45000,
  headers: {
    // React Native appends the correct `boundary=...` to this for FormData
    // bodies; the multer backend needs that to parse the multipart upload.
    'Content-Type': 'multipart/form-data',
    Accept: 'application/json',
  },
});

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

/** Map any thrown error to a categorised, user-presentable VerificationError. */
function toVerificationError(err: unknown): VerificationError {
  if (axios.isAxiosError(err)) {
    const axErr = err as AxiosError;

    // Request aborted due to the configured timeout.
    if (axErr.code === 'ECONNABORTED') {
      return {
        kind: 'timeout',
        message:
          'Server took too long to respond. The server may be waking up — try again.',
      };
    }

    // A response came back with a non-2xx status.
    if (axErr.response) {
      return {
        kind: 'server',
        message:
          serverMessage(axErr.response.data) ?? 'Server error. Please try again.',
      };
    }

    // Request was made but no response (DNS failure, no internet, host down).
    return {
      kind: 'network',
      message: 'No connection to the server. Check your internet and try again.',
    };
  }

  return {
    kind: 'unknown',
    message: 'Something went wrong. Please try again.',
  };
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

  try {
    const { data } = await client.post<VerificationResult>('/api/verify', form);
    return data;
  } catch (err) {
    throw new VerificationCallError(toVerificationError(err));
  }
}

export default verifyLabel;
