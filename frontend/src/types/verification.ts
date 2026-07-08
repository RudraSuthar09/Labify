/**
 * Verification types — mirror the backend response shape exactly.
 * Source of truth: backend `src/services/verification.ts`.
 */

export type VerificationStatus = 'pass' | 'fail' | 'warning';

export type Mismatch = {
  field: string;
  expected: string;
  got: string;
};

export type VerificationResult = {
  status: VerificationStatus;
  decodedBarcode: string;
  expectedValue: string | null;
  extractedFields: Record<string, string>;
  mismatches: Mismatch[];
  missingFields: string[];
  ocrText: string;
  reason: string;
  /** Public URL of the archived scan photo, or null when storage is disabled/failed. */
  imageUrl: string | null;
};

/** Categorised, user-presentable failure of the verification *call* itself. */
export type VerificationError = {
  kind: 'network' | 'timeout' | 'server' | 'unknown';
  message: string;
};
