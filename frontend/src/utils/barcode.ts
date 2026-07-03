/**
 * Normalise a raw scanned code down to the RSN we actually want to verify.
 *
 * The battery-pack label carries two codes for the same unit:
 *   • a 1-D barcode encoding the RSN directly, e.g. "RKBBPFM7C000167"
 *   • a QR code encoding a Reliance XML document with the RSN inside a
 *     <SRNO_7S>…</SRNO_7S> element, e.g.
 *       <?xml version="1.0" encoding="UTF-8"?>
 *       <!--Document created by RJIL http://jio.com-->
 *       <MFRNAME>KABRA EXTRUSIONTECHNIK LTD</MFRNAME>
 *       <MODELNO_7S>JBP000001-7S</MODELNO_7S>
 *       <SRNO_7S>RKBBPFM7C000167</SRNO_7S>
 *
 * Whichever the operator happens to scan, verification should compare the bare
 * RSN against what OCR reads on the label. This pulls the RSN out of the XML
 * payload; a plain barcode value is returned unchanged.
 */

// Matches <SRNO_7S>value</SRNO_7S> (and similar <SRNO...>), case-insensitive.
const SRNO_TAG = /<\s*SRNO[^>]*>\s*([^<]+?)\s*<\s*\/\s*SRNO[^>]*>/i;

export function extractRsn(raw: string): string {
  const value = (raw ?? '').trim();

  // QR XML payload → pull the serial from the <SRNO…> element.
  const tagMatch = value.match(SRNO_TAG);
  if (tagMatch && tagMatch[1]) return tagMatch[1].trim();

  return value;
}

/** True when the scanned payload looks like the Reliance XML (vs a bare code). */
export function isXmlPayload(raw: string): boolean {
  const v = (raw ?? '').trimStart();
  return v.startsWith('<?xml') || v.startsWith('<');
}

export default extractRsn;
