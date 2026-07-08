/**
 * Check C — external serial validation against Reliance's authoritative API.
 *
 * We POST the verified serial number to the configured endpoint and interpret
 * its `Message1` field ("OK" / "NOT_OK"). The service is third-party and known
 * to be occasionally slow or down, so this module is deliberately defensive:
 *
 *   • every call is bounded by EXTERNAL_VALIDATION_TIMEOUT_MS;
 *   • it NEVER throws — transport/timeout/HTTP/parse failures all resolve to a
 *     structured `{ status: 'error', … }` result so a flaky external service can
 *     never crash the backend or block a verification response;
 *   • it can be disabled wholesale via EXTERNAL_VALIDATION_ENABLED for local dev.
 */
import axios from 'axios';

import { env } from '../config/env';
import { logger } from '../utils/logger';

export type ExternalValidationStatus = 'ok' | 'not_ok' | 'error' | 'skipped';

export interface ExternalValidationResult {
  status: ExternalValidationStatus;
  /** Raw `Message1` from the API, or a short human note for skipped/error. */
  rawMessage: string;
  /** Present only when status === 'error'; a short diagnostic. */
  error?: string;
  /** Wall-clock time the call took, in ms (0 when skipped). */
  durationMs: number;
}

/** Expected success body shape. Anything else is treated as an error. */
interface GeonResponse {
  Message1?: string;
}

/**
 * Redact a serial for logging: keep the first 4 and last 4 characters, mask the
 * middle. "RKBBPFM7C000167" → "RKBB…0167". Short serials are fully masked.
 */
export function redactSerial(serial: string): string {
  const s = serial ?? '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Validate a serial against the external API.
 *
 * Resolves (never rejects) with an {@link ExternalValidationResult}. Callers
 * fold this into the overall verification status per the Check C rules.
 */
export async function validateWithExternalApi(
  serialNo: string,
): Promise<ExternalValidationResult> {
  if (!env.EXTERNAL_VALIDATION_ENABLED) {
    return {
      status: 'skipped',
      rawMessage: 'External validation disabled',
      durationMs: 0,
    };
  }

  const started = Date.now();
  const redacted = redactSerial(serialNo);

  try {
    const { data } = await axios.post<GeonResponse>(
      env.EXTERNAL_VALIDATION_URL,
      { RIL_serialNo: serialNo },
      {
        timeout: env.EXTERNAL_VALIDATION_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
        // Don't let axios throw on non-2xx — we classify status ourselves below.
        validateStatus: () => true,
      },
    );
    const durationMs = Date.now() - started;

    const message = typeof data?.Message1 === 'string' ? data.Message1 : '';
    const normalized = message.trim().toUpperCase();

    let status: ExternalValidationStatus;
    if (normalized === 'OK') {
      status = 'ok';
    } else if (normalized === 'NOT_OK') {
      status = 'not_ok';
    } else {
      // Unexpected shape (empty body, HTML error page, different field, …).
      status = 'error';
      logger.warn(
        { serial: redacted, durationMs, responseShape: data },
        'External validation returned an unexpected response shape',
      );
      return {
        status,
        rawMessage: message || '(no Message1 field)',
        error: 'Unexpected response shape from external API',
        durationMs,
      };
    }

    logger.info(
      { serial: redacted, status, durationMs, rawMessage: message },
      'External validation completed',
    );
    return { status, rawMessage: message, durationMs };
  } catch (err) {
    const durationMs = Date.now() - started;
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      { serial: redacted, durationMs, err: detail },
      'External validation call failed (network/timeout/HTTP)',
    );
    return {
      status: 'error',
      rawMessage: 'External validation could not be completed',
      error: detail,
      durationMs,
    };
  }
}

export default validateWithExternalApi;
