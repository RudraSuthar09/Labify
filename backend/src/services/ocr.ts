/**
 * OCR service — turns a label photo into plain text.
 *
 * The rest of the app depends only on the {@link OcrProvider} interface and the
 * {@link getOcrProvider} factory, never on a concrete engine. Swapping Google
 * Vision for AWS Textract or a self-hosted PaddleOCR is therefore a matter of
 * adding a new class here and a new case in the factory — callers are untouched.
 *
 * Selection is driven by the `OCR_PROVIDER` env var (default "google").
 */
import vision from '@google-cloud/vision';
import sharp from 'sharp';

import { env } from '../config/env';
import { logger } from '../utils/logger';

/** Raw result from a provider, before any app-specific parsing. */
export interface OcrResult {
  /** The full detected text, newline-separated as the engine returned it. */
  text: string;
  /**
   * The provider's untouched response payload. Exposed for the debug endpoint
   * and regex tuning; shape is provider-specific and should not be relied on by
   * business logic.
   */
  raw: unknown;
}

/**
 * A pluggable OCR engine. Implementations receive an already-decoded image
 * buffer and return detected text plus the raw response.
 */
export interface OcrProvider {
  /** Stable identifier, e.g. "google" — used in logs. */
  readonly name: string;
  /** Detect text in an image. Should reject on transport/quota/auth failures. */
  detectText(imageBuffer: Buffer): Promise<OcrResult>;
}

/**
 * Convenience wrapper matching the interface requested by callers that only
 * need the text. Runs preprocessing + the configured provider and returns just
 * the detected string.
 */
export async function extractText(imageBuffer: Buffer): Promise<string> {
  const { text } = await runOcr(imageBuffer);
  return text;
}

/**
 * Preprocess a photographed label to give OCR the best chance:
 *   • auto-rotate using the EXIF orientation tag (phones store sideways shots),
 *   • downscale to a sane max width (huge factory photos waste time/quota and
 *     don't improve accuracy),
 *   • a gentle contrast/sharpness boost for faded thermal-printed labels.
 *
 * Always re-encodes to PNG (lossless) so we don't compound JPEG artefacts. On
 * any sharp failure we log and fall back to the original buffer rather than
 * failing the whole request — the raw image may still OCR fine.
 */
export async function preprocessImage(imageBuffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(imageBuffer)
      .rotate() // honours EXIF orientation; no-op when absent
      .resize({ width: 2000, withoutEnlargement: true })
      .normalize() // stretch contrast across the full tonal range
      .sharpen()
      .png()
      .toBuffer();
  } catch (err) {
    logger.warn({ err }, 'Image preprocessing failed — using original buffer');
    return imageBuffer;
  }
}

/**
 * Google Cloud Vision provider using the official @google-cloud/vision client.
 *
 * Authentication (handled by the client, in this order):
 *   1. an explicit API key, if GOOGLE_VISION_API_KEY is set;
 *   2. otherwise Application Default Credentials — typically the service-account
 *      JSON pointed to by GOOGLE_APPLICATION_CREDENTIALS.
 *
 * Uses DOCUMENT_TEXT_DETECTION, which outperforms plain TEXT_DETECTION on the
 * dense, structured text found on equipment labels.
 */
export class GoogleVisionOCR implements OcrProvider {
  readonly name = 'google';
  private readonly client: InstanceType<typeof vision.ImageAnnotatorClient>;

  constructor() {
    this.client = new vision.ImageAnnotatorClient(
      env.GOOGLE_VISION_API_KEY
        ? { apiKey: env.GOOGLE_VISION_API_KEY }
        : {}, // falls back to GOOGLE_APPLICATION_CREDENTIALS / ADC
    );
  }

  async detectText(imageBuffer: Buffer): Promise<OcrResult> {
    const [result] = await this.client.documentTextDetection({
      image: { content: imageBuffer },
    });

    // `fullTextAnnotation.text` is the whole-document text; `textAnnotations[0]`
    // is the same for TEXT_DETECTION. Prefer the former, fall back gracefully.
    const text =
      result.fullTextAnnotation?.text ??
      result.textAnnotations?.[0]?.description ??
      '';

    return { text, raw: result };
  }
}

/**
 * Mock provider for local development and tests. Reads the text to "detect"
 * from the `MOCK_OCR_TEXT` env var (or returns an empty string). Lets the whole
 * verification pipeline run without any cloud credentials or network calls.
 */
export class MockOCR implements OcrProvider {
  readonly name = 'mock';

  async detectText(_imageBuffer: Buffer): Promise<OcrResult> {
    const text = process.env.MOCK_OCR_TEXT ?? '';
    return { text, raw: { provider: 'mock', text } };
  }
}

let cachedProvider: OcrProvider | undefined;

/**
 * Return the OCR provider selected by `OCR_PROVIDER`, constructing it once and
 * caching it (the Vision client is comparatively expensive to build).
 *
 * To add a provider: implement {@link OcrProvider} and add a case here.
 */
export function getOcrProvider(): OcrProvider {
  if (cachedProvider) return cachedProvider;

  switch (env.OCR_PROVIDER) {
    case 'google':
      cachedProvider = new GoogleVisionOCR();
      break;
    case 'mock':
      cachedProvider = new MockOCR();
      break;
    default: {
      // Exhaustiveness guard — a new enum value without a case fails to compile.
      const never: never = env.OCR_PROVIDER;
      throw new Error(`Unsupported OCR_PROVIDER: ${String(never)}`);
    }
  }

  logger.info({ provider: cachedProvider.name }, 'OCR provider initialised');
  return cachedProvider;
}

/**
 * End-to-end OCR: preprocess the image, then run the configured provider.
 * Returns the full {@link OcrResult} (text + raw). Throws on provider failure —
 * callers translate that into a 502.
 */
export async function runOcr(imageBuffer: Buffer): Promise<OcrResult> {
  const processed = await preprocessImage(imageBuffer);
  return getOcrProvider().detectText(processed);
}

/** Test seam: clear the cached provider (e.g. after changing env in a test). */
export function resetOcrProvider(): void {
  cachedProvider = undefined;
}
