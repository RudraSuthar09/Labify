/**
 * POST /api/verify — the core verification endpoint.
 *
 * Accepts a multipart form with the label photo plus the already-decoded
 * barcode value, runs OCR on the image, compares the barcode against the serial
 * printed on the label, and returns a structured pass/warning/fail result.
 *
 * A dev-only POST /api/verify/debug variant additionally returns the raw OCR
 * response, for tuning the label-profile regexes.
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';
import { z } from 'zod';

import { env, isDev } from '../config/env';
import { HttpError } from '../utils/httpError';
import { logger } from '../utils/logger';
import { runOcr } from '../services/ocr';
import { getScanStore } from '../services/scanStore';
import { getStorageProvider } from '../services/storage';
import { verifyLabel } from '../services/verification';
import { KNOWN_LABEL_TYPES, DEFAULT_LABEL_TYPE } from '../config/labelProfiles';

export const verifyRouter = Router();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Per-IP rate limit for the verification endpoints: 60 requests/minute. Guards
 * the free-tier OCR quota (and the host) against runaway clients or abuse.
 * Returns a clean JSON 429 rather than the library's default text body.
 *
 * Relies on Express `trust proxy` being set (see server.ts) so the client IP is
 * read from X-Forwarded-For behind Render's load balancer.
 */
const verifyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        status: 429,
        message: 'Too many requests. Please slow down and try again shortly.',
      },
    });
  },
});

/**
 * In-memory upload handling — we forward the buffer straight to OCR and never
 * touch disk. Rejects anything that isn't an image up front.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      // Surfaced as a 400 by handleUpload below.
      cb(new HttpError(400, `Unsupported file type "${file.mimetype}". Upload an image.`));
    }
  },
});

/**
 * Wrap multer's single-file middleware so its errors become clean JSON 400s
 * instead of default Express error pages. Runs `image` field parsing and hands
 * control to the route on success.
 */
function handleUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('image')(req, res, (err: unknown) => {
    if (!err) return next();

    if (err instanceof MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Image exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit.`
          : err.code === 'LIMIT_UNEXPECTED_FILE'
            ? 'Unexpected file field — send the image in the "image" field.'
            : `Upload error: ${err.message}`;
      return next(new HttpError(400, message));
    }
    // HttpError from the fileFilter, or anything else.
    return next(err instanceof HttpError ? err : new HttpError(400, 'Invalid upload.'));
  });
}

/**
 * Body validation. The image itself is validated separately (by multer).
 *
 * `barcodeValue` (linear barcode) and `qrValue` (QR code) are both optional
 * individually, but at least one must be present — a verification needs at
 * least one scanned code. Empty strings are normalised to null so the client
 * can send `''` for "not detected".
 */
const emptyToNull = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullish()
  .transform((v) => v ?? null);

const VerifyBodySchema = z
  .object({
    barcodeValue: emptyToNull,
    qrValue: emptyToNull,
    labelType: z
      .string()
      .trim()
      .default(DEFAULT_LABEL_TYPE)
      .refine((t) => KNOWN_LABEL_TYPES.includes(t), {
        message: `Unknown labelType. Known types: ${KNOWN_LABEL_TYPES.join(', ')}.`,
      }),
  })
  .refine((b) => b.barcodeValue !== null || b.qrValue !== null, {
    message: 'At least one of barcodeValue or qrValue must be present.',
    path: ['barcodeValue'],
  });

/**
 * Build the object-store path for one scan. Date-partitioned so listings and
 * lifecycle rules can operate on YYYY/MM/DD prefixes.
 */
function buildScanFilename(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `scans/${yyyy}/${mm}/${dd}/${randomUUID()}.jpg`;
}

/**
 * Re-encode the uploaded photo before archiving: rotate from EXIF, cap at
 * 1600 px wide, and emit JPEG q80. Keeps storage costs sane. Falls back to the
 * original buffer if sharp fails (rare) — the archive still runs.
 */
async function compressForStorage(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    logger.warn({ err }, 'Image compression failed — archiving original buffer');
    return buffer;
  }
}

/**
 * Upload the scan to the configured storage provider. Returns the public URL,
 * or null when storage is disabled or the upload failed — a storage failure
 * must never block verification, so callers can safely ignore null.
 */
async function archiveScanImage(buffer: Buffer): Promise<string | null> {
  const storage = getStorageProvider();
  if (!storage) return null;

  const filename = buildScanFilename();
  try {
    const compressed = await compressForStorage(buffer);
    const url = await storage.uploadImage(compressed, filename);
    logger.debug({ filename, provider: storage.name }, 'Scan image archived');
    return url;
  } catch (err) {
    logger.error(
      { err, filename, provider: storage.name },
      'Failed to archive scan image — verification will still complete',
    );
    return null;
  }
}

/**
 * Shared handler for both the public and debug endpoints. Returns the OCR raw
 * payload alongside the result when `includeRaw` is set.
 */
async function runVerification(
  req: Request,
  res: Response,
  includeRaw: boolean,
): Promise<void> {
  const totalStart = Date.now();

  // 1. Validate the text fields.
  const parsed = VerifyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, 'Validation failed', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const { barcodeValue, qrValue, labelType } = parsed.data;

  // 2. Ensure an image was actually uploaded.
  if (!req.file?.buffer?.length) {
    throw new HttpError(400, 'No image uploaded — attach the label photo in the "image" field.');
  }

  // 3. OCR the image and archive it in parallel. OCR failure is a 502; storage
  //    failure only nulls out imageUrl — it never blocks verification.
  const ocrStart = Date.now();
  const [ocrSettled, imageUrl] = await Promise.all([
    runOcr(req.file.buffer).then(
      (r) => ({ ok: true as const, result: r }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    archiveScanImage(req.file.buffer),
  ]);
  const ocrDurationMs = Date.now() - ocrStart;

  if (!ocrSettled.ok) {
    logger.error({ err: ocrSettled.err, barcodeValue, qrValue }, 'OCR provider failed');
    throw new HttpError(
      502,
      'OCR service is currently unavailable. Please try again shortly.',
    );
  }
  const { text: ocrText, raw: ocrRaw } = ocrSettled.result;

  // 4. Run all checks (three-way match, config, external validation), then stamp
  //    the archive URL onto the result. Async because Check C (the external-API
  //    call) performs a bounded network call.
  const verification = {
    ...(await verifyLabel({ barcodeValue, qrValue, ocrText, labelType })),
    imageUrl,
  };

  // 5. Persist to the audit log. Blocking (not fire-and-forget) so a scan is
  //    guaranteed visible in /api/scans by the time the mobile app re-fetches
  //    — otherwise a pull-to-refresh right after a scan can miss it. Failure to
  //    persist is logged but never fails the response: the operator's verdict
  //    is authoritative, and losing the audit row is preferable to blocking
  //    the shop floor.
  const store = getScanStore();
  if (store) {
    try {
      await store.insertScan({
        status: verification.status,
        decodedBarcode: verification.decodedBarcode,
        expectedValue: verification.expectedValue,
        labelType,
        reason: verification.reason,
        extractedFields: verification.extractedFields,
        mismatches: verification.mismatches,
        missingFields: verification.missingFields,
        ocrText: verification.ocrText,
        imageUrl: verification.imageUrl,
      });
    } catch (err) {
      logger.error({ err, barcodeValue }, 'Failed to persist scan — response unaffected');
    }
  }

  const totalDurationMs = Date.now() - totalStart;

  // 6. Structured audit log for every verification (pass or fail alike).
  logger.info(
    {
      barcodeValue,
      qrValue,
      labelType,
      status: verification.status,
      codesMatch: verification.codesMatch,
      configMatch: verification.configCheck.match,
      externalStatus: verification.externalValidation.status,
      reason: verification.reason,
      imageUrl,
      ocrDurationMs,
      totalDurationMs,
    },
    'Label verification completed',
  );

  // fail is a legitimate business outcome, not an HTTP error → always 200.
  res.status(200).json(
    includeRaw
      ? { ...verification, ocrDurationMs, totalDurationMs, rawOcr: ocrRaw }
      : verification,
  );
}

/** POST /api/verify — production endpoint. Rate-limited per IP. */
verifyRouter.post('/api/verify', verifyRateLimiter, handleUpload, (req, res, next) => {
  runVerification(req, res, false).catch(next);
});

/**
 * POST /api/verify/debug — same as /api/verify plus the raw OCR response.
 * Registered only outside production to avoid leaking provider internals.
 */
if (env.NODE_ENV !== 'production') {
  verifyRouter.post('/api/verify/debug', handleUpload, (req, res, next) => {
    runVerification(req, res, true).catch(next);
  });
  logger.info('Dev-only endpoint POST /api/verify/debug is enabled');
}

export default verifyRouter;
