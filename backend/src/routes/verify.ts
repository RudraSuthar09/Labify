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
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import { z } from 'zod';

import { env, isDev } from '../config/env';
import { HttpError } from '../utils/httpError';
import { logger } from '../utils/logger';
import { runOcr } from '../services/ocr';
import { verifyLabel } from '../services/verification';
import { KNOWN_LABEL_TYPES, DEFAULT_LABEL_TYPE } from '../config/labelProfiles';

export const verifyRouter = Router();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

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

/** Body validation. The image itself is validated separately (by multer). */
const VerifyBodySchema = z.object({
  barcodeValue: z
    .string({ message: 'barcodeValue is required.' })
    .trim()
    .min(1, 'barcodeValue must not be empty.'),
  labelType: z
    .string()
    .trim()
    .default(DEFAULT_LABEL_TYPE)
    .refine((t) => KNOWN_LABEL_TYPES.includes(t), {
      message: `Unknown labelType. Known types: ${KNOWN_LABEL_TYPES.join(', ')}.`,
    }),
});

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
  const { barcodeValue, labelType } = parsed.data;

  // 2. Ensure an image was actually uploaded.
  if (!req.file?.buffer?.length) {
    throw new HttpError(400, 'No image uploaded — attach the label photo in the "image" field.');
  }

  // 3. OCR the image. A failure here is an upstream/service problem, not a bad
  //    request, so it becomes a 502 (handled in catch below).
  const ocrStart = Date.now();
  let ocrText: string;
  let ocrRaw: unknown;
  try {
    const result = await runOcr(req.file.buffer);
    ocrText = result.text;
    ocrRaw = result.raw;
  } catch (err) {
    logger.error({ err, barcodeValue }, 'OCR provider failed');
    throw new HttpError(
      502,
      'OCR service is currently unavailable. Please try again shortly.',
    );
  }
  const ocrDurationMs = Date.now() - ocrStart;

  // 4. Compare barcode vs label serial.
  const verification = verifyLabel({ barcodeValue, ocrText, labelType });
  const totalDurationMs = Date.now() - totalStart;

  // 5. Structured audit log for every verification (pass or fail alike).
  logger.info(
    {
      barcodeValue,
      labelType,
      status: verification.status,
      reason: verification.reason,
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

/** POST /api/verify — production endpoint. */
verifyRouter.post('/api/verify', handleUpload, (req, res, next) => {
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
