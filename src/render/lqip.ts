const FNV_OFFSET_BASIS = 0x811c9dc5;

const FNV_PRIME = 0x01000193;

const LQIP_MASK = 0xfffff;

/**
 * 20-bit cover placeholder code derived from a title, decoded by ui/styles/lqip.css.
 * Bit layout follows https://leanrada.com/notes/css-only-lqip/, stored unsigned instead
 * of the article's -2^19 offset:
 *   bits 19..8  six 2-bit grey cells, 3x2, top-left first
 *   bits  7..6  L of the Oklab base colour
 *   bits  5..3  a, bits 2..0  b
 * The CSS departs from the article's renderer: L keeps only the two lightest levels so
 * black cover titles stay readable, a/b are scaled down to pastel chroma, and grey cells
 * sit at 40% opacity so the base hue shows through.
 * Seigiard/opml-generator hashes podcast titles the same way; keep the two in step so
 * one title gets one code in both viewers.
 */
export function lqipFromTitle(title: string): number {
  const bytes = new TextEncoder().encode(title.trim().normalize("NFC").toLowerCase());
  let hash = FNV_OFFSET_BASIS;

  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  }

  return hash & LQIP_MASK;
}
