/**
 * Verification service — the business core.
 *
 * Given a decoded barcode value and the OCR text read off a label photo, decide
 * whether they describe the same unit:
 *
 *   PASS    — barcode exactly matches the label's serial (after normalisation)
 *   WARNING — they differ only slightly (≤ profile tolerance), likely OCR noise
 *   FAIL    — they genuinely disagree, or the serial couldn't be read at all
 *
 * The logic is entirely driven by the label profile, so it works for any label
 * type defined in `labelProfiles.ts` without change.
 */
import {
  getLabelProfile,
  DEFAULT_LABEL_TYPE,
  type LabelProfile,
} from '../config/labelProfiles';
import {
  fuzzyCompare,
  isExactMatch,
  normalize,
} from '../utils/fuzzyMatch';

export type VerificationStatus = 'pass' | 'fail' | 'warning';

export interface FieldMismatch {
  field: string;
  expected: string;
  got: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  /** The barcode value the caller supplied (as decoded from the scan). */
  decodedBarcode: string;
  /** The serial read off the label via OCR, or null if it wasn't found. */
  expectedValue: string | null;
  /** Every field the profile's regexes managed to extract. */
  extractedFields: Record<string, string>;
  /** Fields whose extracted value disagrees with the barcode. */
  mismatches: FieldMismatch[];
  /** Names of required fields the OCR text did not contain. */
  missingFields: string[];
  /** Full OCR text, echoed back for debugging / regex tuning. */
  ocrText: string;
  /** Human-readable explanation aimed at the operator. */
  reason: string;
  /**
   * Public URL of the archived scan photo, or null when storage is disabled or
   * the upload failed (a storage error never blocks verification).
   */
  imageUrl: string | null;
}

export interface VerifyLabelInput {
  barcodeValue: string;
  ocrText: string;
  /** Defaults to the battery_pack profile when omitted/unknown-handled upstream. */
  labelType?: string;
}

/**
 * Run every field regex in the profile against the OCR text.
 * Returns a name→value map containing only the fields that matched.
 */
function extractFields(
  profile: LabelProfile,
  ocrText: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const spec of profile.fieldsToExtract) {
    const match = spec.regex.exec(ocrText);
    if (match && match[1]) {
      fields[spec.name] = match[1].trim();
    }
  }
  return fields;
}

/** Required fields declared by the profile that we failed to extract. */
function findMissingRequiredFields(
  profile: LabelProfile,
  extracted: Record<string, string>,
): string[] {
  return profile.fieldsToExtract
    .filter((f) => f.required && !extracted[f.name])
    .map((f) => f.name);
}

/**
 * Format a short "position N: X→Y" description of the differing characters,
 * used to explain a warning.
 */
function describeCharDiffs(
  diffs: Array<{ index: number; a: string; b: string }>,
): string {
  return diffs
    .map((d) => `position ${d.index + 1}: '${d.b}' vs '${d.a}'`)
    .join(', ');
}

/**
 * Compare a scanned barcode against the serial read off a label and produce a
 * full {@link VerificationResult}. Pure and synchronous — all I/O (OCR) happens
 * before this is called, which keeps the decision logic easy to test.
 */
export function verifyLabel({
  barcodeValue,
  ocrText,
  labelType = DEFAULT_LABEL_TYPE,
}: VerifyLabelInput): VerificationResult {
  const profile = getLabelProfile(labelType);
  if (!profile) {
    // Defensive: routes validate labelType against known profiles first, so
    // this should be unreachable in practice.
    return {
      status: 'fail',
      decodedBarcode: barcodeValue,
      expectedValue: null,
      extractedFields: {},
      mismatches: [],
      missingFields: [],
      ocrText,
      reason: `Unknown label type "${labelType}".`,
      imageUrl: null,
    };
  }

  const extractedFields = extractFields(profile, ocrText);
  const missingFields = findMissingRequiredFields(profile, extractedFields);

  const expectedRaw = extractedFields[profile.barcodeField];
  const expectedValue = expectedRaw ?? null;

  // Case 1: the serial the barcode should match wasn't found on the label.
  if (!expectedRaw) {
    const missingNote =
      missingFields.length > 0
        ? ` Missing required field(s): ${missingFields.join(', ')}.`
        : '';
    return {
      status: 'fail',
      decodedBarcode: barcodeValue,
      expectedValue: null,
      extractedFields,
      mismatches: [],
      missingFields,
      ocrText,
      reason:
        `Could not read the ${profile.barcodeField} from the label, so the ` +
        `scanned barcode "${barcodeValue}" cannot be verified.${missingNote}`,
      imageUrl: null,
    };
  }

  const missingNote =
    missingFields.length > 0
      ? ` (Note: missing required field(s): ${missingFields.join(', ')}.)`
      : '';

  // Case 2: exact match after light normalisation → PASS.
  if (isExactMatch(barcodeValue, expectedRaw)) {
    return {
      status: 'pass',
      decodedBarcode: barcodeValue,
      expectedValue,
      extractedFields,
      mismatches: [],
      missingFields,
      ocrText,
      reason:
        `Barcode matches the ${profile.barcodeField} on the label ` +
        `(${normalize(expectedRaw)}).${missingNote}`,
      imageUrl: null,
    };
  }

  // Not an exact match — measure how far apart they are, OCR-confusions aside.
  const comparison = fuzzyCompare(barcodeValue, expectedRaw);
  const mismatch: FieldMismatch = {
    field: profile.barcodeField,
    expected: expectedRaw,
    got: barcodeValue,
  };

  // Case 3: close enough to be OCR noise → WARNING.
  if (comparison.distance <= profile.fuzzyTolerance) {
    const diffNote =
      comparison.differingChars.length > 0
        ? ` Differing character(s): ${describeCharDiffs(comparison.differingChars)}.`
        : ` Edit distance ${comparison.distance}.`;
    return {
      status: 'warning',
      decodedBarcode: barcodeValue,
      expectedValue,
      extractedFields,
      // A near-match is a soft mismatch — surface it so the operator can eyeball.
      mismatches: [mismatch],
      missingFields,
      ocrText,
      reason:
        `Barcode "${barcodeValue}" is very close to the label's ` +
        `${profile.barcodeField} "${expectedRaw}" but not identical — likely ` +
        `an OCR misread.${diffNote} Please verify manually.${missingNote}`,
      imageUrl: null,
    };
  }

  // Case 4: genuine disagreement → FAIL.
  return {
    status: 'fail',
    decodedBarcode: barcodeValue,
    expectedValue,
    extractedFields,
    mismatches: [mismatch],
    missingFields,
    ocrText,
    reason:
      `Barcode "${barcodeValue}" does not match the label's ` +
      `${profile.barcodeField} "${expectedRaw}" ` +
      `(edit distance ${comparison.distance}).${missingNote}`,
    imageUrl: null,
  };
}
