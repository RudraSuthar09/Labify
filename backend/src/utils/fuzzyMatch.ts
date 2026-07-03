/**
 * Fuzzy string matching tuned for OCR output.
 *
 * OCR engines reliably confuse a handful of visually similar glyphs
 * (O↔0, I↔1, S↔5, B↔8, …). When comparing a decoded barcode against a serial
 * number read off a photographed label, we want those confusions to count as
 * "probably the same character" rather than a genuine mismatch.
 *
 * The public helpers here power the "warning" tier of verification: an exact
 * match is a PASS, a small edit distance (or a pure OCR-confusion difference)
 * is a WARNING, and anything further apart is a FAIL.
 */

/**
 * Pairs of characters that OCR commonly confuses. Each pair is symmetric — the
 * normaliser folds both members onto the same canonical character so that, for
 * example, "O" and "0" become indistinguishable.
 */
const OCR_CONFUSIONS: ReadonlyArray<readonly [string, string]> = [
  ['O', '0'],
  ['I', '1'],
  ['S', '5'],
  ['B', '8'],
  ['Z', '2'],
  ['G', '6'],
];

/** Maps every confusable character to a single canonical representative. */
const CONFUSION_MAP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [a, b] of OCR_CONFUSIONS) {
    // Fold both onto the second (digit) member — the choice is arbitrary but
    // must be consistent on both sides of a comparison.
    map.set(a, b);
    map.set(b, b);
  }
  return map;
})();

/**
 * Uppercase, strip all whitespace, and drop any non-alphanumeric characters.
 * This is the light-touch normalisation applied before an *exact* comparison —
 * it does NOT collapse OCR confusions (that would hide real single-char errors
 * we still want to surface as warnings).
 */
export function normalize(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Like {@link normalize}, but additionally folds OCR-confusable characters onto
 * a canonical form. Two strings that differ only by O↔0, I↔1, etc. become byte
 * identical here.
 */
export function normalizeForOcr(value: string): string {
  const base = normalize(value);
  let out = '';
  for (const ch of base) out += CONFUSION_MAP.get(ch) ?? ch;
  return out;
}

/**
 * Classic Levenshtein (insert/delete/substitute, each cost 1) between two
 * strings, computed with a rolling single-row DP in O(a·b) time and O(b) space.
 * The inputs are compared as-is — normalise first if you want case/whitespace
 * insensitivity.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    // Swap rows (copy, since we reuse the array).
    prev = curr.slice();
  }

  return prev[b.length];
}

/** Describes how close two strings are after OCR-aware normalisation. */
export interface FuzzyResult {
  /** True when the strings are within `maxDistance` edits (after normalising). */
  isMatch: boolean;
  /** True only when normalised forms are byte-identical (distance 0). */
  isExact: boolean;
  /** Levenshtein distance between the OCR-normalised forms. */
  distance: number;
  /**
   * Human-readable per-position character differences between the two
   * normalised strings, useful for explaining a warning to the operator.
   * Only populated for same-length strings (the common OCR-substitution case).
   */
  differingChars: Array<{ index: number; a: string; b: string }>;
}

/**
 * Compare two strings the way a human inspector would: ignore case, whitespace,
 * and known OCR glyph confusions, then measure how many real edits remain.
 */
export function fuzzyCompare(a: string, b: string): FuzzyResult {
  const na = normalizeForOcr(a);
  const nb = normalizeForOcr(b);
  const distance = levenshteinDistance(na, nb);

  const differingChars: FuzzyResult['differingChars'] = [];
  // Report per-position glyph differences using the *raw-normalised*
  // (non-confusion-folded) forms, so the operator sees the actual characters —
  // e.g. an O↔0 confusion still surfaces here even though it folds to distance 0.
  const ra = normalize(a);
  const rb = normalize(b);
  if (ra.length === rb.length) {
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) {
        differingChars.push({ index: i, a: ra[i] ?? '', b: rb[i] ?? '' });
      }
    }
  }

  return {
    isMatch: false, // filled in by isFuzzyMatch / verifier against a tolerance
    isExact: distance === 0,
    distance,
    differingChars,
  };
}

/**
 * True when `a` and `b` are within `maxDistance` edits after OCR-aware
 * normalisation. `maxDistance` of 0 is an exact (normalised) match.
 */
export function isFuzzyMatch(a: string, b: string, maxDistance: number): boolean {
  return levenshteinDistance(normalizeForOcr(a), normalizeForOcr(b)) <= maxDistance;
}

/** True when the two strings are identical after light normalisation. */
export function isExactMatch(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}
