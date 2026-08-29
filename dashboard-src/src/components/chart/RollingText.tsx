/**
 * Odometer-style text. Each segment renders every candidate value stacked
 * vertically inside a clipped, fixed-height window; changing the active value
 * slides the stack rather than swapping the text. This is what makes the
 * reference dashboard's hovered-date pill roll instead of flicker.
 *
 * The window is REEL_HEIGHT tall and the stack is translated by
 * -index * REEL_HEIGHT, so exactly one row is ever visible.
 */

/** Matches the reference's `h-6` reel window. */
const REEL_HEIGHT = 24;

/** The reference's roll — long enough to read, eased so it settles rather than stops. */
const ROLL_TRANSITION = "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)";

export interface Reel {
  /** Every value this segment can display, in the order it should roll through. */
  values: string[];
  /** Index into `values` that should be showing. */
  index: number;
}

function Segment({ values, index }: Reel) {
  // A value outside the list would scroll the stack to an empty row, which
  // reads as the pill going blank. Clamping keeps the last good row visible.
  const safe = Math.min(Math.max(index, 0), values.length - 1);
  return (
    <span
      className="relative block overflow-hidden"
      style={{ height: REEL_HEIGHT }}
      aria-hidden
    >
      <span
        className="block"
        style={{
          transform: `translateY(${-safe * REEL_HEIGHT}px)`,
          transition: ROLL_TRANSITION,
        }}
      >
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="flex items-center justify-center tabular-nums"
            style={{ height: REEL_HEIGHT }}
          >
            {v}
          </span>
        ))}
      </span>
    </span>
  );
}

export default function RollingText({ reels, label }: { reels: Reel[]; label: string }) {
  return (
    <span className="relative block overflow-hidden" style={{ height: REEL_HEIGHT }}>
      {/* The reels are aria-hidden; this carries the value for assistive tech. */}
      <span className="sr-only">{label}</span>
      <span className="flex items-center justify-center gap-1">
        {reels.map((r, i) => (
          <Segment key={i} values={r.values} index={r.index} />
        ))}
      </span>
    </span>
  );
}

export { REEL_HEIGHT };
