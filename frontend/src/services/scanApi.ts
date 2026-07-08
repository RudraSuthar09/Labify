/**
 * Read-side backend API — the endpoints HistoryScreen and the stats header
 * hit while browsing past verifications.
 *
 * Kept separate from {@link verifyLabel} because the write path is complex
 * (multipart, queue-on-failure, retry) whereas these calls are plain JSON GETs
 * that never queue — if they fail, the UI just shows an error card and offers
 * pull-to-refresh.
 */
import env from '../config/env';
import type { VerificationStatus } from '../types/verification';

/** Same 30s timeout the settings health-check uses. */
const READ_TIMEOUT_MS = 30000;

/** Categorised failure of a read call. */
export type ReadError = {
  kind: 'network' | 'timeout' | 'server' | 'unavailable' | 'unknown';
  message: string;
};

export class ScanApiError extends Error {
  readonly info: ReadError;
  constructor(info: ReadError) {
    super(info.message);
    this.name = 'ScanApiError';
    this.info = info;
    Object.setPrototypeOf(this, ScanApiError.prototype);
  }
}

/** One row as returned by the backend `/api/scans` list endpoint. */
export interface ScanListItem {
  id: string;
  createdAt: string;
  decodedBarcode: string;
  expectedValue: string | null;
  labelType: string;
  status: VerificationStatus;
  reason: string;
  extractedFields: Record<string, string>;
  mismatches: Array<{ field: string; expected: string; got: string }>;
  missingFields: string[];
  ocrText: string;
  imageUrl: string | null;
}

export interface ScanPage {
  items: ScanListItem[];
  nextCursor: string | null;
}

export interface FetchScansOptions {
  status?: VerificationStatus;
  cursor?: string;
  /** 1..100. Backend clamps if out of range. */
  limit?: number;
  /** Aborts the request if provided by the caller (used to cancel a stale page). */
  signal?: AbortSignal;
}

export interface TodayStats {
  date: string;
  total: number;
  pass: number;
  fail: number;
  warning: number;
  passRate: number | null;
}

/** Backend error body shape (see backend/errorHandler.ts). */
interface BackendErrorBody {
  error?: { status?: number; message?: string };
}
function serverMessage(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const body = data as BackendErrorBody;
    if (body.error && typeof body.error.message === 'string') return body.error.message;
  }
  return undefined;
}

/**
 * Shared JSON GET helper. Wires an AbortController so we can cancel via the
 * caller's signal OR our own timeout, whichever fires first.
 *
 * Returns the parsed JSON on 2xx. Throws {@link ScanApiError} otherwise, with
 * a categorised `kind` the caller can branch on ('unavailable' means the
 * feature is off on this deployment — different UX from a transient failure).
 */
async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!env.apiConfigured) {
    throw new ScanApiError({
      kind: 'unknown',
      message: 'App is not configured with a backend URL.',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  // Forward external aborts (screen unmount, page cancel) to our controller.
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward);

  let res: Response;
  try {
    res = await fetch(env.apiBaseUrl + path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
    if ((err as { name?: string }).name === 'AbortError') {
      // Distinguish caller-cancelled vs our own timeout by inspecting the
      // caller's signal — a cancel isn't a timeout worth telling the user.
      if (signal?.aborted) {
        throw new ScanApiError({ kind: 'unknown', message: 'Request cancelled.' });
      }
      throw new ScanApiError({
        kind: 'timeout',
        message: 'Server took too long to respond. Try again.',
      });
    }
    throw new ScanApiError({
      kind: 'network',
      message: 'No connection to the server. Check your internet and try again.',
    });
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', forward);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ScanApiError({
      kind: 'server',
      message: 'Server returned an invalid response.',
    });
  }

  if (!res.ok) {
    if (res.status === 503) {
      throw new ScanApiError({
        kind: 'unavailable',
        message:
          serverMessage(body) ??
          'This feature is not enabled on the server.',
      });
    }
    throw new ScanApiError({
      kind: 'server',
      message: serverMessage(body) ?? `Server error (${res.status}).`,
    });
  }

  return body as T;
}

/** GET /api/scans — page of past verifications, newest first. */
export function fetchScans(options: FetchScansOptions = {}): Promise<ScanPage> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return getJson<ScanPage>(`/api/scans${qs ? `?${qs}` : ''}`, options.signal);
}

/** GET /api/stats — today's totals + pass rate. */
export function fetchStats(signal?: AbortSignal): Promise<TodayStats> {
  return getJson<TodayStats>('/api/stats', signal);
}
