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

/** The three encodings of the serial the backend tried to reconcile (Check A). */
export type CodesDetected = {
  barcode: string | null;
  qr: string | null;
  printedRsn: string | null;
};

/** Header-vs-RSN config-digit cross-check (Check B). */
export type ConfigCheck = {
  headerConfig: string | null;
  rsnConfigChar: string | null;
  /** true/false when both read; null when either couldn't be extracted. */
  match: boolean | null;
};

/** External authoritative-API outcome (Check C). */
export type ExternalValidationStatus = 'ok' | 'not_ok' | 'error' | 'skipped';

export type ExternalValidation = {
  status: ExternalValidationStatus;
  rawMessage: string;
  error?: string;
  durationMs: number;
};

export type VerificationResult = {
  status: VerificationStatus;
  decodedBarcode: string | null;
  decodedQr: string | null;
  expectedValue: string | null;
  codesDetected: CodesDetected;
  codesMatch: boolean;
  extractedFields: Record<string, string>;
  mismatches: Mismatch[];
  missingFields: string[];
  configCheck: ConfigCheck;
  externalValidation: ExternalValidation;
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
