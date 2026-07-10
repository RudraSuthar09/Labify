/**
 * Scan store — the persistence layer for verified label scans.
 *
 * Backs the mobile app's HistoryScreen ({@link ScanStore.listScans}) and stats
 * header ({@link ScanStore.todayStats}), and is written to from POST /api/verify
 * ({@link ScanStore.insertScan}).
 *
 * Uses MongoDB. The collection is created automatically on first write, so there
 * is no migration to run — set MONGODB_URI and it works.
 *
 * All methods are non-throwing at the write path: a database failure during
 * insert must never block verification. Reads throw a descriptive Error the API
 * layer turns into a 500.
 */
import { MongoClient, ObjectId, type Collection } from 'mongodb';

import { env } from '../config/env';
import { logger } from '../utils/logger';
import type {
  VerificationResult,
  VerificationStatus,
} from './verification';

/** The MongoDB document shape (camelCase, stored natively). */
interface ScanDoc {
  _id: ObjectId;
  createdAt: Date;
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
  /** 1–100, defaults to 20. Clamped in {@link ScanStore.listScans}. */
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

/** Input for {@link ScanStore.insertScan}: what /api/verify already computed. */
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

// --- Helpers ----------------------------------------------------------------

const COLLECTION = 'scans';
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

/** Compact, human-readable description of a driver error for the API response. */
function describeDbError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown database error';
}

function docToScan(doc: ScanDoc): StoredScan {
  return {
    id: doc._id.toHexString(),
    createdAt: doc.createdAt.toISOString(),
    decodedBarcode: doc.decodedBarcode ?? '',
    expectedValue: doc.expectedValue ?? null,
    labelType: doc.labelType,
    status: doc.status,
    reason: doc.reason,
    extractedFields: doc.extractedFields ?? {},
    mismatches: doc.mismatches ?? [],
    missingFields: doc.missingFields ?? [],
    ocrText: doc.ocrText ?? '',
    imageUrl: doc.imageUrl ?? null,
  };
}

// --- Implementation ---------------------------------------------------------

class MongoScanStore implements ScanStore {
  private readonly client: MongoClient;
  /** Resolves to the ready collection (connected + indexes ensured). */
  private readonly ready: Promise<Collection<ScanDoc>>;

  constructor(uri: string, dbName: string) {
    this.client = new MongoClient(uri);
    this.ready = this.client.connect().then((c) => {
      const col = c.db(dbName).collection<ScanDoc>(COLLECTION);
      // Match the browse orderings the queries rely on. Idempotent; safe to call
      // on every boot. Failures here are non-fatal — Mongo will still serve
      // (unindexed) queries, so we log and continue.
      void col
        .createIndexes([
          { key: { createdAt: -1, _id: -1 } },
          { key: { status: 1, createdAt: -1, _id: -1 } },
        ])
        .catch((err) => logger.warn({ err }, 'Failed to ensure scan indexes'));
      logger.info({ db: dbName, collection: COLLECTION }, 'Mongo scan store connected');
      return col;
    });
  }

  async insertScan(input: InsertScanInput): Promise<StoredScan | null> {
    try {
      const col = await this.ready;
      const doc: Omit<ScanDoc, '_id'> = {
        createdAt: new Date(),
        // QR-only scans have a null barcode; store '' so the column is always a
        // string for the list UI.
        decodedBarcode: input.decodedBarcode ?? '',
        expectedValue: input.expectedValue,
        labelType: input.labelType,
        status: input.status,
        reason: input.reason,
        extractedFields: input.extractedFields,
        mismatches: input.mismatches,
        missingFields: input.missingFields,
        ocrText: input.ocrText,
        imageUrl: input.imageUrl,
      };
      const res = await col.insertOne(doc as ScanDoc);
      return docToScan({ ...(doc as ScanDoc), _id: res.insertedId });
    } catch (err) {
      logger.error({ err }, 'Failed to persist scan — verification response is unaffected');
      return null;
    }
  }

  async listScans(options: ListScansOptions): Promise<ScanPage> {
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

    // Base filter: optional status.
    const filter: Record<string, unknown> = {};
    if (options.status) filter.status = options.status;

    // Keyset pagination on (createdAt desc, _id desc): everything strictly
    // "older" than the cursor tuple.
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded && ObjectId.isValid(decoded.id)) {
        const ts = new Date(decoded.ts);
        const oid = new ObjectId(decoded.id);
        filter.$or = [
          { createdAt: { $lt: ts } },
          { createdAt: ts, _id: { $lt: oid } },
        ];
      }
      // Malformed cursor → ignore, treat as first page.
    }

    try {
      const col = await this.ready;
      // Fetch one extra to detect a next page without a separate count.
      const rows = await col
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map(docToScan);
      const last = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor(last.createdAt.toISOString(), last._id.toHexString())
          : null;

      return { items, nextCursor };
    } catch (err) {
      logger.error({ err }, 'Failed to read scans');
      throw new Error(`Failed to read scans: ${describeDbError(err)}`);
    }
  }

  async todayStats(): Promise<TodayStats> {
    // "Today" is UTC — the same clock the DB uses for insert timestamps.
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const dateIso = startOfDay.toISOString().slice(0, 10); // YYYY-MM-DD

    try {
      const col = await this.ready;
      const grouped = await col
        .aggregate<{ _id: VerificationStatus; n: number }>([
          { $match: { createdAt: { $gte: startOfDay } } },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ])
        .toArray();

      let pass = 0;
      let fail = 0;
      let warning = 0;
      for (const g of grouped) {
        if (g._id === 'pass') pass = g.n;
        else if (g._id === 'fail') fail = g.n;
        else if (g._id === 'warning') warning = g.n;
      }
      const total = pass + fail + warning;
      const passRate = total === 0 ? null : pass / total;

      return { date: dateIso, total, pass, fail, warning, passRate };
    } catch (err) {
      logger.error({ err }, 'Failed to read daily stats');
      throw new Error(`Failed to read daily stats: ${describeDbError(err)}`);
    }
  }
}

// --- Factory ----------------------------------------------------------------

let cached: ScanStore | undefined;
let resolved = false;

/**
 * The configured scan store, or `undefined` when persistence is not enabled
 * (missing MONGODB_URI). Matches the storage.ts factory pattern so callers can
 * degrade the same way.
 *
 * Callers must handle `undefined`:
 *   - /api/verify: log a warn and skip persistence.
 *   - /api/scans, /api/stats: return a 503 so the client can distinguish
 *     "temporarily unavailable" from "no data".
 */
export function getScanStore(): ScanStore | undefined {
  if (resolved) return cached;
  resolved = true;

  if (!env.MONGODB_URI) {
    logger.info(
      'Scan persistence is disabled (MONGODB_URI unset) — ' +
        '/api/scans and /api/stats will return 503.',
    );
    return undefined;
  }

  cached = new MongoScanStore(env.MONGODB_URI, env.MONGODB_DB);
  logger.info('Scan store initialised (MongoDB)');
  return cached;
}

/** Test seam: clear the cached provider after mutating env. */
export function resetScanStore(): void {
  cached = undefined;
  resolved = false;
}
