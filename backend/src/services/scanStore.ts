/**
 * Scan store — the persistence layer for verified label scans.
 *
 * Backs the mobile app's HistoryScreen ({@link listScans}) and stats header
 * ({@link todayStats}), and is written to from POST /api/verify
 * ({@link insertScan}).
 *
 * Uses Supabase Postgres (same project as image storage). The Supabase JS
 * service-role client bypasses RLS — it must never be exposed to the frontend.
 *
 * All methods are non-throwing at the persistence layer: a database failure
 * during insert must never block verification, and a failed read is surfaced
 * via a well-typed Result. The API layer decides the HTTP mapping.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '../config/env';
import { logger } from '../utils/logger';
import type {
  VerificationResult,
  VerificationStatus,
} from './verification';

/** The Postgres row shape — snake_case, matches `db/001_init_scans.sql`. */
interface ScanRow {
  id: string;
  created_at: string;
  decoded_barcode: string;
  expected_value: string | null;
  label_type: string;
  status: VerificationStatus;
  reason: string;
  extracted_fields: Record<string, string>;
  mismatches: Array<{ field: string; expected: string; got: string }>;
  missing_fields: string[];
  ocr_text: string;
  image_url: string | null;
}

/** Client-facing (camelCase) view of a persisted scan. */
export interface StoredScan {
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

export interface ListScansOptions {
  /** Filter by status, or omit for all. */
  status?: VerificationStatus;
  /**
   * Opaque cursor from a previous page's `nextCursor`. Callers should not try
   * to decode it — it's an implementation detail (base64 keyset tuple).
   */
  cursor?: string;
  /** 1–100, defaults to 20. Clamped in {@link listScans}. */
  limit?: number;
}

export interface ScanPage {
  items: StoredScan[];
  /** Present when there is more; pass back as `cursor` for the next page. */
  nextCursor: string | null;
}

export interface TodayStats {
  /** Server's UTC date the numbers are computed for (YYYY-MM-DD). */
  date: string;
  total: number;
  pass: number;
  fail: number;
  warning: number;
  /** 0–1, or null when total=0 (avoid a misleading "0%"). */
  passRate: number | null;
}

/** Input for {@link insertScan}: what /api/verify already computed. */
export interface InsertScanInput
  extends Pick<
    VerificationResult,
    | 'status'
    | 'decodedBarcode'
    | 'expectedValue'
    | 'extractedFields'
    | 'mismatches'
    | 'missingFields'
    | 'ocrText'
    | 'reason'
    | 'imageUrl'
  > {
  labelType: string;
}

export interface ScanStore {
  insertScan(input: InsertScanInput): Promise<StoredScan | null>;
  listScans(options: ListScansOptions): Promise<ScanPage>;
  todayStats(): Promise<TodayStats>;
}

// --- Implementation ---------------------------------------------------------

const TABLE = 'scans';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Encode a keyset cursor as base64url; decoded shape is `{ ts, id }`. */
function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id }), 'utf8').toString('base64url');
}

/** Returns null on any malformed cursor — caller treats as "start from newest". */
function decodeCursor(cursor: string): { ts: string; id: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { ts?: unknown; id?: unknown };
    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') return null;
    return { ts: parsed.ts, id: parsed.id };
  } catch {
    return null;
  }
}

function rowToScan(row: ScanRow): StoredScan {
  return {
    id: row.id,
    createdAt: row.created_at,
    decodedBarcode: row.decoded_barcode,
    expectedValue: row.expected_value,
    labelType: row.label_type,
    status: row.status,
    reason: row.reason,
    extractedFields: row.extracted_fields ?? {},
    mismatches: row.mismatches ?? [],
    missingFields: row.missing_fields ?? [],
    ocrText: row.ocr_text ?? '',
    imageUrl: row.image_url,
  };
}

class SupabaseScanStore implements ScanStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async insertScan(input: InsertScanInput): Promise<StoredScan | null> {
    const row = {
      decoded_barcode: input.decodedBarcode,
      expected_value: input.expectedValue,
      label_type: input.labelType,
      status: input.status,
      reason: input.reason,
      extracted_fields: input.extractedFields,
      mismatches: input.mismatches,
      missing_fields: input.missingFields,
      ocr_text: input.ocrText,
      image_url: input.imageUrl,
    };

    const { data, error } = await this.client
      .from(TABLE)
      .insert(row)
      .select('*')
      .single<ScanRow>();

    if (error) {
      logger.error({ err: error }, 'Failed to persist scan — verification response is unaffected');
      return null;
    }
    return rowToScan(data);
  }

  async listScans(options: ListScansOptions): Promise<ScanPage> {
    const limit = Math.min(
      Math.max(1, options.limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    let query = this.client
      .from(TABLE)
      .select('*')
      // Descending on (created_at, id) — same order the composite index provides.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      // Ask for one extra row so we can tell whether a next page exists without a
      // second COUNT(*) query.
      .limit(limit + 1);

    if (options.status) {
      query = query.eq('status', options.status);
    }

    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        // Keyset: (created_at, id) < (ts, id). PostgREST expresses tuple compare
        // via .or() with a nested .and().
        query = query.or(
          `created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`,
        );
      }
      // Malformed cursor → ignore, treat as first page. Defensive; the client
      // should not have produced it.
    }

    const { data, error } = await query.returns<ScanRow[]>();
    if (error) {
      logger.error({ err: error }, 'Failed to read scans');
      throw new Error('Failed to read scans');
    }

    const rows = data ?? [];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(rowToScan);
    const last = pageRows[pageRows.length - 1];
    // Normalise to `...Z` form so the cursor value never contains a `+` that
    // PostgREST's URL parser would decode as a space. Both forms represent the
    // same instant; the DB stores UTC internally.
    const nextCursor =
      hasMore && last
        ? encodeCursor(new Date(last.created_at).toISOString(), last.id)
        : null;

    return { items, nextCursor };
  }

  async todayStats(): Promise<TodayStats> {
    // "Today" is UTC — the same clock the DB uses for now(), so this matches
    // what a NOW-based dashboard would show. Callers that need per-timezone
    // buckets will add a query param later.
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const dateIso = startOfDay.toISOString().slice(0, 10); // YYYY-MM-DD

    // Small select — status column only, filtered by day. Aggregating in JS
    // keeps this a single index-covered scan on the composite index and
    // avoids Postgres GROUP BY over the JSONB columns.
    const { data, error } = await this.client
      .from(TABLE)
      .select('status')
      .gte('created_at', startOfDay.toISOString())
      .returns<Array<{ status: VerificationStatus }>>();

    if (error) {
      logger.error({ err: error }, 'Failed to read daily stats');
      throw new Error('Failed to read daily stats');
    }

    let pass = 0;
    let fail = 0;
    let warning = 0;
    for (const row of data ?? []) {
      if (row.status === 'pass') pass += 1;
      else if (row.status === 'fail') fail += 1;
      else if (row.status === 'warning') warning += 1;
    }
    const total = pass + fail + warning;
    const passRate = total === 0 ? null : pass / total;

    return { date: dateIso, total, pass, fail, warning, passRate };
  }
}

// --- Factory ----------------------------------------------------------------

let cached: ScanStore | undefined;
let resolved = false;

/**
 * The configured scan store, or `undefined` when persistence is not enabled
 * (missing SUPABASE_URL / SUPABASE_SERVICE_KEY). Matches the storage.ts
 * factory pattern so callers can degrade the same way.
 *
 * Callers must handle `undefined`:
 *   - /api/verify: log a warn and skip persistence.
 *   - /api/scans, /api/stats: return a 503 so the client can distinguish
 *     "temporarily unavailable" from "no data".
 */
export function getScanStore(): ScanStore | undefined {
  if (resolved) return cached;
  resolved = true;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    logger.info(
      'Scan persistence is disabled (SUPABASE_URL / SUPABASE_SERVICE_KEY unset) — ' +
        '/api/scans and /api/stats will return 503.',
    );
    return undefined;
  }

  cached = new SupabaseScanStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  logger.info('Scan store initialised');
  return cached;
}

/** Test seam: clear the cached provider after mutating env. */
export function resetScanStore(): void {
  cached = undefined;
  resolved = false;
}
