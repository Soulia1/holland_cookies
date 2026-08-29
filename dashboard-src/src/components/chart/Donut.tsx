import { useMemo, useState } from "react";
import ChartTooltip from "./ChartTooltip";

/**
 * Donut sharing the reference dashboard's interaction language: the hovered
 * wedge pushes outward, the centre label crossfades from the total to that
 * wedge, and the same blurred tooltip follows the pointer.
 */

export interface DonutSlice {
  name: string;
  value: number;
}

interface Props {
  data: DonutSlice[];
  colors: string[];
  size?: number;
  /** Formats a slice value for the tooltip and the centre. */
  format?: (n: number) => string;
  /** Sits under the total when nothing is hovered. */
  caption: string;
}

const INNER = 56;
const OUTER = 82;
/** How far the hovered wedge lifts out of the ring. */
const LIFT = 6;
/** Gap between wedges, in degrees. */
const PAD_ANGLE = 2;

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number) {
  const large = a1 - a0 > 180 ? 1 : 0;
  const o0 = polar(cx, cy, rOut, a0);
  const o1 = polar(cx, cy, rOut, a1);
  const i1 = polar(cx, cy, rIn, a1);
  const i0 = polar(cx, cy, rIn, a0);
  return [
    `M${o0.x},${o0.y}`,
    `A${rOut},${rOut} 0 ${large} 1 ${o1.x},${o1.y}`,
    `L${i1.x},${i1.y}`,
    `A${rIn},${rIn} 0 ${large} 0 ${i0.x},${i0.y}`,
    "Z",
  ].join("");
}

export default function Donut({
  data,
  colors,
  size = 168,
  format = (n) => n.toLocaleString(),
  caption,
}: Props) {
  const [active, setActive] = useState<number | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  const total = useMemo(() => data.reduce((a, d) => a + d.value, 0), [data]);
  const cx = size / 2;
  const cy = size / 2;

  const wedges = useMemo(() => {
    if (!total) return [];
    let cursor = 0;
    return data.map((d, i) => {
      const sweep = (d.value / total) * 360;
      const a0 = cursor + PAD_ANGLE / 2;
      const a1 = cursor + sweep - PAD_ANGLE / 2;
      cursor += sweep;
      // A wedge thinner than its own padding would invert into a sliver.
      return { ...d, i, a0, a1: Math.max(a1, a0 + 0.01) };
    });
  }, [data, total]);

  const activeSlice = active !== null ? data[active] : null;

  return (
    <div className="chart-motion relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        // The lifted wedge reaches a few pixels past the box; SVG clips by default.
        className="block overflow-visible"
        onPointerLeave={() => setActive(null)}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setPointer({ x: e.clientX - box.left, y: e.clientY - box.top });
        }}
      >
        {wedges.map((w) => {
          const on = active === w.i;
          return (
            <path
              key={w.name}
              d={arcPath(cx, cy, INNER, OUTER, w.a0, w.a1)}
              fill={colors[w.i % colors.length]}
              onPointerEnter={() => setActive(w.i)}
              style={{
                // The lift is a scale about the donut's centre, not a bigger
                // radius: browsers cannot transition the `d` attribute, so
                // re-deriving the arc would make the wedge jump.
                transform: on ? `scale(${(OUTER + LIFT) / OUTER})` : "scale(1)",
                transformOrigin: `${cx}px ${cy}px`,
                transition:
                  "transform 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease",
                opacity: active === null || on ? 1 : 0.55,
                cursor: "pointer",
              }}
            />
          );
        })}
      </svg>

      {/* Centre label — total and hovered slice crossfade in place. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="absolute flex flex-col items-center transition-opacity duration-200"
          style={{ opacity: activeSlice ? 0 : 1 }}
        >
          <span className="text-xl font-semibold tabular-nums">{total.toLocaleString()}</span>
          <span className="text-xs text-muted-foreground">{caption}</span>
        </span>
        <span
          className="absolute flex max-w-[110px] flex-col items-center transition-opacity duration-200"
          style={{ opacity: activeSlice ? 1 : 0 }}
        >
          <span className="text-xl font-semibold tabular-nums">
            {activeSlice ? format(activeSlice.value) : ""}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {activeSlice?.name ?? ""}
          </span>
        </span>
      </div>

      {activeSlice && (
        <div
          className="pointer-events-none absolute z-50 w-max"
          style={{
            // Anchored to the ring rather than the raw pointer so the panel is
            // never widened by a tooltip chasing the cursor off its edge.
            left: pointer.x > size / 2 ? undefined : size + 12,
            right: pointer.x > size / 2 ? size + 12 : undefined,
            top: Math.min(Math.max(pointer.y - 20, 0), size - 60),
          }}
        >
          <ChartTooltip
            heading={`${Math.round((activeSlice.value / (total || 1)) * 100)}% of sales`}
            rows={[
              {
                name: activeSlice.name,
                value: format(activeSlice.value),
                color: colors[(active ?? 0) % colors.length],
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
