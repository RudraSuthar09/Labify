/**
 * Quick barcode check against the Reliance / Geon authoritative API.
 *
 * The endpoint accepts `{ RIL_serialNo }` and returns `{ Message1: "OK"|"NOT_OK" }`.
 * We expose a small typed wrapper so the screen can render pass / fail / unknown
 * without knowing the wire format.
 */

const RIL_CHECK_URL = 'https://api.geon.world/api/Check_RIL_Barcode';
const REQUEST_TIMEOUT_MS = 15000;

export type RilCheckStatus = 'ok' | 'not_ok' | 'unknown';

export interface RilCheckResult {
  status: RilCheckStatus;
  /** Raw Message1 from the API (or the stringified body if that field was missing). */
  message: string;
  /** The full parsed response body, kept for the "Raw response" panel. */
  raw: unknown;
}

export class RilCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RilCheckError';
    Object.setPrototypeOf(this, RilCheckError.prototype);
  }
}

export async function checkRilBarcode(barcode: string): Promise<RilCheckResult> {
  const trimmed = (barcode ?? '').trim();
  if (!trimmed) {
    throw new RilCheckError('Empty barcode — nothing to check.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(RIL_CHECK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ RIL_serialNo: trimmed }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === 'AbortError') {
      throw new RilCheckError(
        'Request timed out. The RIL server may be slow — try again.',
      );
    }
    throw new RilCheckError(
      'No connection to the RIL server. Check your internet and try again.',
    );
  }
  clearTimeout(timer);

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON — surface the HTTP status so the operator knows what happened.
    if (!res.ok) {
      throw new RilCheckError(`RIL server returned HTTP ${res.status}.`);
    }
    throw new RilCheckError('RIL server returned a non-JSON response.');
  }

  if (!res.ok) {
    throw new RilCheckError(`RIL server returned HTTP ${res.status}.`);
  }

  const message =
    body && typeof body === 'object' && typeof (body as { Message1?: unknown }).Message1 === 'string'
      ? ((body as { Message1: string }).Message1)
      : '';

  const normalized = message.trim().toUpperCase();
  let status: RilCheckStatus;
  if (normalized === 'OK') status = 'ok';
  else if (normalized === 'NOT_OK') status = 'not_ok';
  else status = 'unknown';

  return { status, message, raw: body };
}

export default checkRilBarcode;
