/**
 * Label verification service.
 *
 * `verifyLabel` will eventually POST the scanned barcode value and a still photo
 * of the label to the backend, which runs OCR on the image and compares the
 * extracted text against the barcode payload. For now this is a stub that
 * simulates network latency and returns a `pending` result.
 */
import env from '../config/env';

export type VerificationStatus = 'pass' | 'fail' | 'pending';

export interface VerificationResult {
  status: VerificationStatus;
  /** Human-readable summary, shown to the operator. */
  message?: string;
  /** The barcode value that was checked. */
  barcodeValue?: string;
  /** OCR-extracted fields, populated once the backend is wired up. */
  extracted?: Record<string, string>;
}

/**
 * Verify a scanned label.
 *
 * @param barcodeValue Decoded barcode/QR payload.
 * @param imageUri     Local URI of the captured still frame.
 *
 * TODO: replace the stub body with a real call to `${env.apiBaseUrl}/verify`
 * (multipart upload of the image + barcodeValue). API base URL and OCR provider
 * come from `src/config/env.ts` — never hardcode them here.
 */
export async function verifyLabel(
  barcodeValue: string,
  imageUri: string,
): Promise<VerificationResult> {
  // Reference config so the wiring is obvious and lint-clean; also handy in logs.
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log(
      `[verifyLabel] stub → would POST to ${env.apiBaseUrl}/verify ` +
        `(provider="${env.ocrProvider}") value="${barcodeValue}" image="${imageUri}"`,
    );
  }

  // Simulate a 1-second backend round-trip.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  return {
    status: 'pending',
    message: 'Verification not implemented yet.',
    barcodeValue,
  };
}

export default verifyLabel;
