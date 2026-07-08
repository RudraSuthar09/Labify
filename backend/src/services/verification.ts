/**
 * Verification service — the business core.
 *
 * Given the codes decoded off a label (a linear barcode and/or a QR code) plus
 * the OCR text read from the label photo, decide whether they all describe the
 * same unit. Four layers of checks run, and the strictest outcome wins:
 *
 *   Check A — three-way match: linear barcode = QR = printed RSN
 *   Check B — config-character consistency: header "{N}S1P" ↔ RSN config digit
 *   (field extraction / required fields — as before)
 *   Check C — external validation against Reliance's authoritative API
 *
 * Aggregate outcome:
 *   PASS    — every applicable check agrees (and the external API says OK)
 *   WARNING — soft issues only (partial detection, OCR noise, external API down)
 *   FAIL    — a genuine disagreement, or the external API says NOT_OK
 *
 * The logic is driven by the label profile, so it works for any label type
 * defined in `labelProfiles.ts` without change.
 */
import {
  getLabelProfile,
  DEFAULT_LABEL_TYPE,
  type LabelProfile,
} from '../config/labelProfiles';
import {
  fuzzyCompare,
  isExactMatch,
} from '../utils/fuzzyMatch';
import {
  validateWithExternalApi,
  type ExternalValidationResult,
} from './externalValidation';

export type VerificationStatus = 'pass' | 'fail' | 'warning';

export interface FieldMismatch {
  field: string;
  expected: string;
  got: string;
}

/** The three encodings of the serial we try to reconcile (Check A). */
export interface CodesDetected {
  barcode: string | null;
  qr: string | null;
  printedRsn: string | null;
}

/** Result of the config-character cross-check (Check B). */
export interface ConfigCheck {
  /** Leading module count from the header config, e.g. "7". */
  headerConfig: string | null;
  /** Config digit read from the RSN, e.g. "7". */
  rsnConfigChar: string | null;
  /** true/false when both were read; null when either couldn't be extracted. */
  match: boolean | null;
}

export interface VerificationResult {
  status: VerificationStatus;
  /** The linear barcode value the caller supplied, or null if none detected. */
  decodedBarcode: string | null;
  /** The QR code value the caller supplied, or null if none detected. */
  decodedQr: string | null;
  /** The serial read off the label via OCR, or null if it wasn't found. */
  expectedValue: string | null;
  /** All three serial encodings, for transparency (Check A). */
  codesDetected: CodesDetected;
  /** True only if every *present* code value agrees exactly. */
  codesMatch: boolean;
  /** Every field the profile's regexes managed to extract. */
  extractedFields: Record<string, string>;
  /** Fields whose extracted value disagrees with the barcode. */
  mismatches: FieldMismatch[];
  /** Names of required fields the OCR text did not contain. */
  missingFields: string[];
  /** Header-vs-RSN config-digit cross-check (Check B). */
  configCheck: ConfigCheck;
  /** External authoritative-API result (Check C). */
  externalValidation: ExternalValidationResult;
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
  /** Linear barcode value (already reduced to the bare RSN), or null. */
  barcodeValue: string | null;
  /** QR code value (already reduced to the bare RSN), or null. */
  qrValue?: string | null;
  ocrText: string;
  /** Defaults to the battery_pack profile when omitted/unknown-handled upstream. */
  labelType?: string;
}

/** Fail > warning > pass, so the strictest of several outcomes can be picked. */
const STATUS_RANK: Record<VerificationStatus, number> = {
  pass: 0,
  warning: 1,
  fail: 2,
};

function worst(a: VerificationStatus, b: VerificationStatus): VerificationStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** Empty / whitespace-only strings are treated as "not detected". */
function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

// --- Check A: three-way match ------------------------------------------------

interface CodeEntry {
  key: 'barcode' | 'qr' | 'printed';
  label: string;
  value: string;
}

interface ThreeWayOutcome {
  status: VerificationStatus;
  codesMatch: boolean;
  mismatches: FieldMismatch[];
  note: string;
}

/**
 * Reconcile the present codes (linear barcode, QR, printed RSN). Any two that
 * are exactly equal agree; near-equal (within the profile's fuzzy tolerance)
 * counts as likely OCR noise → warning; genuinely different → fail.
 */
function threeWayMatch(
  present: CodeEntry[],
  tolerance: number,
): ThreeWayOutcome {
  if (present.length === 0) {
    // Unreachable in practice (the route requires at least one code, and the
    // printed RSN is added when present) — handled defensively.
    return {
      status: 'fail',
      codesMatch: false,
      mismatches: [],
      note: 'No codes were available to compare.',
    };
  }

  if (present.length === 1) {
    // Only one of the three encodings was available — nothing to cross-check
    // against internally, so this is a partial detection.
    return {
      status: 'warning',
      codesMatch: false,
      mismatches: [],
      note: `Only the ${present[0].label} was detected; no other code to cross-check against (partial detection).`,
    };
  }

  const mismatches: FieldMismatch[] = [];
  let anyNear = false;
  let anyDisagree = false;

  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const a = present[i];
      const b = present[j];
      if (isExactMatch(a.value, b.value)) continue;

      const { distance } = fuzzyCompare(a.value, b.value);
      if (distance <= tolerance) {
        anyNear = true;
      } else {
        anyDisagree = true;
        mismatches.push({
          field: `${a.label} vs ${b.label}`,
          expected: a.value,
          got: b.value,
        });
      }
    }
  }

  if (anyDisagree) {
    return {
      status: 'fail',
      codesMatch: false,
      mismatches,
      note: 'Detected codes disagree — the pack fails the three-way match.',
    };
  }

  if (anyNear) {
    return {
      status: 'warning',
      codesMatch: false,
      mismatches: present
        .slice(1)
        .map((p) => ({ field: `${present[0].label} vs ${p.label}`, expected: present[0].value, got: p.value })),
      note: 'Detected codes are very close but not identical — likely OCR noise. Please verify manually.',
    };
  }

  // All present codes are exactly equal.
  if (present.length === 3) {
    return {
      status: 'pass',
      codesMatch: true,
      mismatches: [],
      note: 'All three codes (barcode, QR, printed RSN) match.',
    };
  }

  // Exactly two present and equal → the third is missing.
  return {
    status: 'warning',
    codesMatch: true,
    mismatches: [],
    note: 'Only 2 of 3 codes detected; matched values agree.',
  };
}

// --- Check B: config-character consistency -----------------------------------

interface ConfigOutcome {
  configCheck: ConfigCheck;
  status: VerificationStatus;
  mismatch: FieldMismatch | null;
  /** Fields to merge into extractedFields for transparency. */
  extraFields: Record<string, string>;
  /** Whether "ConfigCode" should be reported as a missing field. */
  missing: boolean;
  note: string;
}

/**
 * Cross-check the header config code against the config digit embedded in the
 * RSN. See labelProfiles.ts for the position/format ASSUMPTION (config digit at
 * a fixed 1-indexed position in the RSN).
 */
function configConsistencyCheck(
  profile: LabelProfile,
  ocrText: string,
  printedRsn: string | null,
): ConfigOutcome {
  const none: ConfigOutcome = {
    configCheck: { headerConfig: null, rsnConfigChar: null, match: null },
    status: 'pass',
    mismatch: null,
    extraFields: {},
    missing: false,
    note: '',
  };

  // Profiles without a config rule skip this check entirely.
  if (
    !profile.headerConfigRegex ||
    profile.rsnConfigCharPosition == null
  ) {
    return none;
  }

  const headerMatch = profile.headerConfigRegex.exec(ocrText);
  const headerConfig = headerMatch && headerMatch[1] ? headerMatch[1] : null;

  // Config digit sits at a fixed 1-indexed position within the RSN.
  let rsnConfigChar: string | null = null;
  if (printedRsn) {
    const idx = profile.rsnConfigCharPosition - 1;
    const ch = printedRsn.charAt(idx) || null;
    // Only accept recognised config digits; anything else is "unreadable".
    if (ch && (!profile.validConfigChars || profile.validConfigChars.includes(ch))) {
      rsnConfigChar = ch;
    }
  }

  // Either side couldn't be read → don't fail on this alone; note it missing.
  if (!headerConfig || !rsnConfigChar) {
    return {
      configCheck: { headerConfig, rsnConfigChar, match: null },
      status: 'pass',
      mismatch: null,
      extraFields: {
        ...(headerConfig ? { HeaderConfig: `${headerConfig}S1P` } : {}),
        ...(rsnConfigChar ? { RsnConfigDigit: rsnConfigChar } : {}),
      },
      missing: true,
      note: 'Config check skipped — header config or RSN config digit could not be read.',
    };
  }

  if (headerConfig === rsnConfigChar) {
    return {
      configCheck: { headerConfig, rsnConfigChar, match: true },
      status: 'pass',
      mismatch: null,
      extraFields: {
        ConfigCode: `${headerConfig}S1P → RSN digit ${rsnConfigChar} ✓`,
        HeaderConfig: `${headerConfig}S1P`,
        RsnConfigDigit: rsnConfigChar,
      },
      missing: false,
      note: `Config consistent: header ${headerConfig}S1P matches RSN digit ${rsnConfigChar}.`,
    };
  }

  return {
    configCheck: { headerConfig, rsnConfigChar, match: false },
    status: 'fail',
    mismatch: { field: 'ConfigCode', expected: headerConfig, got: rsnConfigChar },
    extraFields: {
      HeaderConfig: `${headerConfig}S1P`,
      RsnConfigDigit: rsnConfigChar,
    },
    missing: false,
    note: `Config mismatch: header says ${headerConfig}S1P but RSN indicates ${rsnConfigChar}.`,
  };
}

// --- Check C aggregation -----------------------------------------------------

/**
 * Fold the external-API outcome into the internal status per the Check C rules:
 *   internal fail                 → fail (external ignored)
 *   internal pass + external OK   → pass
 *   internal pass + external NOT_OK → fail
 *   internal pass + external error/skip → warning / pass respectively
 *   internal warning + external OK/error/skip → warning (the warning stands)
 */
function applyExternal(
  internal: VerificationStatus,
  external: ExternalValidationResult,
): { status: VerificationStatus; note: string } {
  if (internal === 'fail') {
    return { status: 'fail', note: '' };
  }

  switch (external.status) {
    case 'ok':
      return {
        status: internal, // pass stays pass, warning stays warning
        note: 'External validation succeeded (Message1: OK).',
      };
    case 'not_ok':
      return {
        status: 'fail',
        note: 'External validation failed: NOT_OK.',
      };
    case 'error':
      return {
        status: worst(internal, 'warning'),
        note: 'External validation could not be completed (Reliance API unreachable or errored); other checks passed.',
      };
    case 'skipped':
    default:
      return { status: internal, note: 'External validation was skipped.' };
  }
}

// --- Main entry point --------------------------------------------------------

/**
 * Run all checks (A, B, field extraction, C) and produce a full
 * {@link VerificationResult}. Async because Check C performs a network call —
 * that call is bounded by a timeout and never throws (see externalValidation).
 */
export async function verifyLabel({
  barcodeValue,
  qrValue,
  ocrText,
  labelType = DEFAULT_LABEL_TYPE,
}: VerifyLabelInput): Promise<VerificationResult> {
  const barcode = clean(barcodeValue);
  const qr = clean(qrValue);

  const profile = getLabelProfile(labelType);
  if (!profile) {
    // Defensive: routes validate labelType against known profiles first, so
    // this should be unreachable in practice.
    return {
      status: 'fail',
      decodedBarcode: barcode,
      decodedQr: qr,
      expectedValue: null,
      codesDetected: { barcode, qr, printedRsn: null },
      codesMatch: false,
      extractedFields: {},
      mismatches: [],
      missingFields: [],
      configCheck: { headerConfig: null, rsnConfigChar: null, match: null },
      externalValidation: {
        status: 'skipped',
        rawMessage: 'External validation skipped (unknown label type)',
        durationMs: 0,
      },
      ocrText,
      reason: `Unknown label type "${labelType}".`,
      imageUrl: null,
    };
  }

  const extractedFields = extractFields(profile, ocrText);
  const missingFields = findMissingRequiredFields(profile, extractedFields);
  const printedRsn = clean(extractedFields[profile.barcodeField]);

  // --- Check A: three-way match --------------------------------------------
  const present: CodeEntry[] = [];
  if (barcode) present.push({ key: 'barcode', label: 'barcode', value: barcode });
  if (qr) present.push({ key: 'qr', label: 'QR', value: qr });
  if (printedRsn) present.push({ key: 'printed', label: 'printed RSN', value: printedRsn });

  const threeWay = threeWayMatch(present, profile.fuzzyTolerance);

  // --- Check B: config consistency -----------------------------------------
  const config = configConsistencyCheck(profile, ocrText, printedRsn);
  const mergedFields = { ...extractedFields, ...config.extraFields };
  const mergedMissing = config.missing
    ? [...missingFields, 'ConfigCode']
    : missingFields;

  const mismatches: FieldMismatch[] = [
    ...threeWay.mismatches,
    ...(config.mismatch ? [config.mismatch] : []),
  ];

  // Internal status = strictest of the internal checks.
  const internalStatus = worst(threeWay.status, config.status);

  // --- Check C: external validation ----------------------------------------
  // Serial to validate: prefer the linear barcode, then QR, then printed RSN.
  const serialToValidate = barcode ?? qr ?? printedRsn;
  const external: ExternalValidationResult = serialToValidate
    ? await validateWithExternalApi(serialToValidate)
    : {
        status: 'skipped',
        rawMessage: 'No serial available to validate',
        durationMs: 0,
      };

  const externalApplied = applyExternal(internalStatus, external);
  const finalStatus = externalApplied.status;

  // --- Assemble the human-readable reason ----------------------------------
  const parts = [threeWay.note];
  if (config.note) parts.push(config.note);
  if (externalApplied.note) parts.push(externalApplied.note);
  if (mergedMissing.length > 0) {
    parts.push(`Missing field(s): ${mergedMissing.join(', ')}.`);
  }
  const reason = parts.filter(Boolean).join(' ');

  return {
    status: finalStatus,
    decodedBarcode: barcode,
    decodedQr: qr,
    expectedValue: printedRsn,
    codesDetected: { barcode, qr, printedRsn },
    codesMatch: threeWay.codesMatch,
    extractedFields: mergedFields,
    mismatches,
    missingFields: mergedMissing,
    configCheck: config.configCheck,
    externalValidation: external,
    ocrText,
    reason,
    imageUrl: null,
  };
}
