/**
 * Label profiles — declarative descriptions of the printed labels we know how
 * to verify. A profile tells the verifier which fields to pull out of the OCR
 * text, which of those the scanned barcode should match, and how forgiving to
 * be about OCR noise.
 *
 * Adding support for a new label is intentionally a *data* change: define a new
 * profile object here and register it in `LABEL_PROFILES`. No verifier code
 * needs to change. See backend/README.md → "Adding new label profiles".
 */

/** A single field to extract from the OCR text via a regular expression. */
export interface FieldSpec {
  /** Stable identifier, e.g. "RSN". Used as the key in extracted-field maps. */
  name: string;
  /**
   * Regex whose first capture group is the field value. Run against the full
   * OCR text (which spans multiple lines). Use the `i` flag for case tolerance;
   * avoid anchoring to line starts since OCR line order is unreliable.
   */
  regex: RegExp;
  /** When true, a missing value contributes to the failure reason. */
  required: boolean;
}

export interface LabelProfile {
  /** Machine name, matches the `labelType` request field. */
  type: string;
  /** Human-friendly label for logs and messages. */
  displayName: string;
  /** Every field we attempt to read off this label. */
  fieldsToExtract: FieldSpec[];
  /**
   * Name of the field (from `fieldsToExtract`) that the scanned barcode value
   * is expected to equal. This is the crux of verification.
   */
  barcodeField: string;
  /**
   * Maximum Levenshtein distance (after OCR-aware normalisation) at which a
   * non-exact barcode/label comparison is downgraded to a WARNING rather than a
   * FAIL. 0 disables the warning tier (only exact matches pass).
   */
  fuzzyTolerance: number;
}

/**
 * Battery pack label:
 *
 *   Rechargeable LiFePO4 Battery Pack        7S1P/15S1P
 *   Model No.: JBP000001-7S
 *   Nominal Voltage: 22.4 V
 *   Nominal Energy: 7.04 kWh
 *   Capacity: 314 Ah
 *   [barcode]  RSN:RKBBPFM7C000167
 */
const batteryPackProfile: LabelProfile = {
  type: 'battery_pack',
  displayName: 'Battery Pack',
  barcodeField: 'RSN',
  fuzzyTolerance: 1,
  fieldsToExtract: [
    {
      // The critical field: the RSN the barcode must match.
      name: 'RSN',
      regex: /RSN\s*[:.]?\s*([A-Z0-9]{10,20})/i,
      required: true,
    },
    {
      name: 'ModelNo',
      regex: /Model\s*No\.?\s*[:.]?\s*([A-Z0-9-]+)/i,
      required: true,
    },
    {
      name: 'NominalVoltage',
      regex: /Nominal\s*Voltage\s*[:.]?\s*([\d.]+\s*V)/i,
      required: false,
    },
    {
      name: 'NominalEnergy',
      regex: /Nominal\s*Energy\s*[:.]?\s*([\d.]+\s*kWh)/i,
      required: false,
    },
    {
      name: 'Capacity',
      regex: /Capacity\s*[:.]?\s*([\d.]+\s*Ah)/i,
      required: false,
    },
  ],
};

/** Registry of all known profiles, keyed by `type`. */
export const LABEL_PROFILES: Readonly<Record<string, LabelProfile>> = {
  [batteryPackProfile.type]: batteryPackProfile,
};

export const DEFAULT_LABEL_TYPE = 'battery_pack';

/** Look up a profile by type, or `undefined` if unknown. */
export function getLabelProfile(type: string): LabelProfile | undefined {
  return LABEL_PROFILES[type];
}

/** The label types this build knows how to verify. */
export const KNOWN_LABEL_TYPES = Object.keys(LABEL_PROFILES);
