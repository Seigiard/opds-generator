const FNV_OFFSET_BASIS = 0x811c9dc5;

const FNV_PRIME = 0x01000193;

const LQIP_MASK = 0xfffff;

const RATIO_SHIFT = 20;

const RATIO_STEPS = 0xfff;

// Width/height span of the four fixed cover shapes the grid used before: 210/350 to 235/320.
const RATIO_MIN = 0.6;

const RATIO_MAX = 0.734;

/**
 * 20-bit cover placeholder code derived from a title, decoded by ui/styles/lqip.css.
 * Bit layout follows https://leanrada.com/notes/css-only-lqip/, stored unsigned instead
 * of the article's -2^19 offset:
 *   bits 19..8  six 2-bit grey cells, 3x2, top-left first
 *   bits  7..6  lightness of the base colour
 *   bits  5..0  colour (the article's a and b)
 * The CSS departs from the article's renderer: the six colour bits pick one of 64 OKLCH
 * hues at fixed chroma 0.08, so no title lands on a near-grey base; lightness stays in
 * 0.78–0.88 so black cover titles stay readable; grey cells blend with soft-light, which
 * lightens or shades the hue instead of washing it out.
 * Seigiard/opml-generator hashes podcast titles the same way; keep the two in step so
 * one title gets one code in both viewers.
 */
export function lqipFromTitle(title: string): number {
  return titleHash(title) & LQIP_MASK;
}

/**
 * Cover width/height ratio derived from a title, so a book keeps its shape when the folder
 * order changes. Takes the top 12 bits of the mixed hash, rounded to three decimals within
 * RATIO_MIN..RATIO_MAX.
 */
export function coverRatioFromTitle(title: string): number {
  const step = mix(titleHash(title)) >>> RATIO_SHIFT;
  const ratio = RATIO_MIN + (step / RATIO_STEPS) * (RATIO_MAX - RATIO_MIN);

  return Math.round(ratio * 1000) / 1000;
}

// FNV-1a 32-bit over the UTF-8 bytes of the trimmed, NFC-normalised, lower-cased title.
function titleHash(title: string): number {
  const bytes = new TextEncoder().encode(title.trim().normalize("NFC").toLowerCase());
  let hash = FNV_OFFSET_BASIS;

  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  }

  return hash;
}

// MurmurHash3 fmix32. FNV-1a barely moves its high bits when only the last characters
// differ, so without it every volume of a series ("Batman 014", "Batman 015") got one shape.
function mix(hash: number): number {
  let h = hash ^ (hash >>> 16);
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return h >>> 0;
}
