// Route colours lighter than this (relative luminance, 0 to 1) don't stand out on a light map by
// themselves: BART's yellow, Caltrain's grey locals.
const PALE_LUMINANCE = 0.5;

/** Whether a route colour (hex, without '#') needs a dark edge to show up on the map. */
export function isPale(hex: string | null | undefined): boolean {
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return false;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > PALE_LUMINANCE;
}
