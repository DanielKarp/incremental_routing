import type { HillProfile as Profile } from '../plan/hills';

const WIDTH = 160;
const HEIGHT = 28;
/** Heights are drawn to one scale up to this span (metres), so a small hill looks small. */
const MIN_SPAN_M = 100;

/** A hilly ride's height profile, simplified to its silhouette. */
export function HillProfile({ profile }: { profile: Profile }) {
  const { points, lowM, highM, climbM, descentM } = profile;
  const length = points[points.length - 1][0] || 1;
  const span = Math.max(MIN_SPAN_M, highM - lowM);
  // Kept 1px inside the box so the 2px line isn't clipped at the top or bottom.
  const x = (d: number) => ((d / length) * WIDTH).toFixed(1);
  const y = (h: number) => (HEIGHT - 1 - ((h - lowM) / span) * (HEIGHT - 2)).toFixed(1);
  const line = points.map(([d, h]) => `${x(d)},${y(h)}`).join(' ');
  const label =
    `Height profile: ${Math.round(lowM)} to ${Math.round(highM)} m above sea level, ` +
    `climbing ${climbM} m and descending ${descentM} m`;
  return (
    <svg
      className="hill-profile"
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <polygon className="hill-area" points={`0,${HEIGHT} ${line} ${WIDTH},${HEIGHT}`} />
      <polyline className="hill-line" points={line} />
    </svg>
  );
}
