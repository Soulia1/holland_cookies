import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ChartTooltip from "./ChartTooltip";
import RollingText, { REEL_HEIGHT } from "./RollingText";

/**
 * Area chart rebuilt to match the reference dashboard (efferd dashboard-7)
 * detail for detail:
 *
 *  · the series line is stroked with a HORIZONTAL gradient that fades to
 *    nothing over the first and last 15%, so it dissolves into the panel
 *    instead of stopping at a hard edge;
 *  · the fill under it is a VERTICAL gradient (20% → 0) additionally masked
 *    by a horizontal fade over the outer 20%;
 *  · the dashed grid rows get their own, wider fade mask (outer 10%);
 *  · hovering snaps a vertical crosshair and a haloed marker to the nearest
 *    point, and rolls the date pill on the axis rather than swapping it.
 *
 * Drawn directly rather than through a chart library because the masks, the
 * HTML-positioned axis labels and the odometer pill all need exact pixel
 * control that a wrapper would fight.
 */

export interface AreaPoint {
  /** Cairo day key, YYYY-MM-DD. */
  date: string;
  value: number;
}

interface Props {
  data: AreaPoint[];
  /** Renders the value for the tooltip and the y-axis. */
  format: (n: number) => string;
  /** Compact form for y-axis ticks; falls back to `format`. */
  formatTick?: (n: number) => string;
  /** Series name shown in the tooltip row. */
  name: string;
  height?: number;
  /** Off for the compact sparkline: no axis labels, no date pill. */
  showAxes?: boolean;
  color?: string;
}

const PAD_TOP = 8;
const PAD_RIGHT = 8;
const AXIS_LEFT = 52;
const AXIS_BOTTOM = 38;

/** Parses a YYYY-MM-DD key without letting the local timezone shift the day. */
function parseYmd(ymd: string): Date | null {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function monthShort(d: Date): string {
  return d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
}

/** "Thu, 9 Apr" — the reference's tooltip heading, in the admin's en-GB order. */
function headingFor(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * Axis ticks on 1/2/2.5/5/10 × 10ⁿ steps, so the top gridline is a round
 * number at or above the peak instead of the peak itself.
 */
function niceTicks(max: number, count = 6): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/**
 * Tracks the element's rendered width so the SVG can be laid out in real
 * pixels. Rounded and change-guarded: a sub-pixel width that flips back and
 * forth would re-enter the observer every frame and lock the renderer up.
 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (next: number) => {
      const rounded = Math.round(next);
      setWidth((prev) => (prev === rounded ? prev : rounded));
    };
    const ro = new ResizeObserver(([entry]) => apply(entry.contentRect.width));
    ro.observe(el);
    apply(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The hover follow. In the reference, everything that moves eases toward the
 * hovered point instead of teleporting, and the layers arrive at slightly
 * different times — the marker leads, the tooltip trails it, the date pill
 * trails furthest. That stagger is what makes the interaction read as one
 * smooth gesture rather than four things snapping at once.
 *
 * Driven by CSS transitions rather than a per-frame spring: they animate off
 * the main thread, survive a stalled rAF (a background or occluded tab would
 * otherwise strand the marker mid-flight), and cost no re-renders.
 *
 * Easing is slow-in/slow-out to approximate the reference's damped spring,
 * which starts gently, peaks mid-flight and settles asymptotically.
 */
const FOLLOW_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const FOLLOW_MARKER = `transform 240ms ${FOLLOW_EASE}`;
const FOLLOW_TOOLTIP = `left 300ms ${FOLLOW_EASE}`;
const FOLLOW_PILL = `left 360ms ${FOLLOW_EASE}`;

/** Measures an overlay so it can be kept inside the panel instead of forcing it wider. */
function useOverlayWidth(deps: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const next = ref.current?.offsetWidth ?? 0;
    setW((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  }, [deps]);
  return [ref, w] as const;
}

export default function AreaChart({
  data,
  format,
  formatTick,
  name,
  height = 260,
  showAxes = true,
  color = "var(--chart-line-primary)",
}: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const uid = useId().replace(/:/g, "");

  const padLeft = showAxes ? AXIS_LEFT : 0;
  const padBottom = showAxes ? AXIS_BOTTOM : 0;
  const plotW = Math.max(width - padLeft - PAD_RIGHT, 0);
  const plotH = Math.max(height - PAD_TOP - padBottom, 0);

  const ticks = useMemo(
    () => niceTicks(Math.max(...data.map((d) => d.value), 0)),
    [data]
  );
  const top = ticks[ticks.length - 1] || 1;

  // A single point has no horizontal extent to interpolate across, so it is
  // pinned to the middle rather than dividing by zero.
  const xAt = useCallback(
    (i: number) => padLeft + (data.length < 2 ? plotW / 2 : (i / (data.length - 1)) * plotW),
    [data.length, padLeft, plotW]
  );
  const yAt = useCallback((v: number) => PAD_TOP + plotH - (v / top) * plotH, [plotH, top]);

  const { linePath, areaPath } = useMemo(() => {
    if (!data.length || !plotW || !plotH) return { linePath: "", areaPath: "" };
    const pts = data.map((d, i) => `${xAt(i)},${yAt(d.value)}`);
    const line = `M${pts.join("L")}`;
    const base = PAD_TOP + plotH;
    return {
      linePath: line,
      areaPath: `${line}L${xAt(data.length - 1)},${base}L${xAt(0)},${base}Z`,
    };
  }, [data, plotW, plotH, xAt, yAt]);

  /** Nearest point to the pointer — the crosshair snaps, it does not float. */
  const onMove = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      if (!data.length) return;
      const box = e.currentTarget.getBoundingClientRect();
      const rel = e.clientX - box.left;
      const ratio = plotW > 0 ? rel / plotW : 0;
      const i = Math.round(ratio * (data.length - 1));
      setActive(Math.min(Math.max(i, 0), data.length - 1));
    },
    [data.length, plotW]
  );

  const activePoint = active !== null ? data[active] : null;
  const activeDate = activePoint ? parseYmd(activePoint.date) : null;

  // Both reels scroll through the series' own values, so the roll distance is
  // proportional to how far the pointer travelled.
  const dayValues = useMemo(
    () => data.map((d) => String(parseYmd(d.date)?.getUTCDate() ?? "")),
    [data]
  );
  const monthValues = useMemo(() => {
    const out: string[] = [];
    for (const d of data) {
      const parsed = parseYmd(d.date);
      const m = parsed ? monthShort(parsed) : "";
      if (m && out[out.length - 1] !== m) out.push(m);
    }
    return out.length ? out : [""];
  }, [data]);
  const monthIndex = useMemo(() => {
    if (!activeDate) return 0;
    const idx = monthValues.indexOf(monthShort(activeDate));
    return idx < 0 ? 0 : idx;
  }, [activeDate, monthValues]);

  // Evenly spaced x labels — every point would collide at 30+ days.
  const xLabelIdx = useMemo(() => {
    if (data.length <= 1) return data.map((_, i) => i);
    const want = Math.min(7, data.length);
    const step = (data.length - 1) / (want - 1);
    return Array.from({ length: want }, (_, k) => Math.round(k * step));
  }, [data.length]);

  const tickFmt = formatTick ?? format;
  const markerX = active !== null ? xAt(active) : 0;
  const markerY = activePoint ? yAt(activePoint.value) : 0;

  // Both overlays are measured and clamped to the panel. Letting either spill
  // past the edge can toggle a scrollbar, which resizes the panel, which
  // re-fires the observer — a loop that freezes the tab.
  const [tipRef, tipW] = useOverlayWidth(active);
  const [pillRef, pillW] = useOverlayWidth(active);
  const clamp = (v: number, w: number) => Math.min(Math.max(v, 0), Math.max(width - w, 0));
  // Past ~65% the panel runs out of room, so the tooltip flips to the left.
  const flip = width > 0 && markerX > width * 0.65;
  const tipLeft = clamp(flip ? markerX - 14 - tipW : markerX + 14, tipW);
  const pillLeft = clamp(markerX - pillW / 2, pillW);

  return (
    <div
      ref={wrapRef}
      className="chart-motion relative w-full select-none"
      style={{ height }}
      onPointerLeave={() => setActive(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible">
          <defs>
            {/* Under-curve wash: strongest at the line, gone at the baseline. */}
            <linearGradient id={`fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.2} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>

            {/* The line's own fade — applied as its stroke, not as a mask. */}
            <linearGradient id={`stroke-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={color} stopOpacity={0} />
              <stop offset="15%" stopColor={color} stopOpacity={1} />
              <stop offset="85%" stopColor={color} stopOpacity={1} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>

            {/* Fill fades over the outer 20% … */}
            <linearGradient id={`edge-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#fff" stopOpacity={0} />
              <stop offset="20%" stopColor="#fff" stopOpacity={1} />
              <stop offset="80%" stopColor="#fff" stopOpacity={1} />
              <stop offset="100%" stopColor="#fff" stopOpacity={0} />
            </linearGradient>
            <mask id={`edgeMask-${uid}`}>
              <rect x={padLeft} y={0} width={plotW} height={height} fill={`url(#edge-${uid})`} />
            </mask>

            {/* … the grid rows over the outer 10%, so they out-run the fill. */}
            <linearGradient id={`gridFade-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#fff" stopOpacity={0} />
              <stop offset="10%" stopColor="#fff" stopOpacity={1} />
              <stop offset="90%" stopColor="#fff" stopOpacity={1} />
              <stop offset="100%" stopColor="#fff" stopOpacity={0} />
            </linearGradient>
            <mask id={`gridMask-${uid}`}>
              <rect x={padLeft} y={0} width={plotW} height={height} fill={`url(#gridFade-${uid})`} />
            </mask>
          </defs>

          <g mask={`url(#gridMask-${uid})`}>
            {ticks.map((t) => (
              <line
                key={t}
                x1={padLeft}
                x2={padLeft + plotW}
                y1={yAt(t)}
                y2={yAt(t)}
                stroke="var(--chart-grid)"
                strokeWidth={1}
                strokeDasharray="4,4"
              />
            ))}
          </g>

          {areaPath && (
            <path d={areaPath} fill={`url(#fill-${uid})`} mask={`url(#edgeMask-${uid})`} />
          )}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke={`url(#stroke-${uid})`}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Geometry lives in the transforms, not in x/y attributes: SVG
              attributes cannot be transitioned, transforms can. The group
              slides horizontally, the dot rides up and down inside it — with
              matched timing, so between neighbouring points the dot tracks
              the segment it is travelling along. */}
          {activePoint && (
            <g
              pointerEvents="none"
              style={{ transform: `translateX(${markerX}px)`, transition: FOLLOW_MARKER }}
            >
              <line
                x1={0}
                x2={0}
                y1={PAD_TOP}
                y2={PAD_TOP + plotH}
                stroke="var(--chart-crosshair)"
                strokeWidth={1}
              />
              <g style={{ transform: `translateY(${markerY}px)`, transition: FOLLOW_MARKER }}>
                <circle cx={0} cy={0} r={8} fill="var(--chart-ring-background)" />
                <circle
                  cx={0}
                  cy={0}
                  r={4}
                  fill="var(--chart-marker-foreground)"
                  stroke="var(--chart-marker-border)"
                  strokeWidth={2}
                />
              </g>
            </g>
          )}

          {/* Pointer surface — covers the plot only, so leaving it clears state. */}
          <rect
            x={padLeft}
            y={PAD_TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
          />
        </svg>
      )}

      {/* Axis labels are HTML, not <text> — it is what lets the active tick
          become a rolling pill without re-measuring SVG glyphs. */}
      {showAxes && width > 0 && (
        <>
          <div
            className="pointer-events-none absolute top-0 bottom-0 left-0"
            style={{ width: padLeft }}
          >
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute right-0 flex items-center justify-end pr-2 text-xs text-[var(--chart-label)] tabular-nums"
                style={{ top: yAt(t), transform: "translateY(-50%)" }}
              >
                {tickFmt(t)}
              </span>
            ))}
          </div>

          <div className="pointer-events-none absolute inset-0">
            {xLabelIdx.map((i) => {
              const d = parseYmd(data[i]?.date ?? "");
              if (!d) return null;
              return (
                <span
                  key={i}
                  className="absolute text-xs whitespace-nowrap text-[var(--chart-label)]"
                  style={{
                    left: xAt(i),
                    top: PAD_TOP + plotH + 12,
                    transform: "translateX(-50%)",
                  }}
                >
                  {d.toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC",
                  })}
                </span>
              );
            })}
          </div>
        </>
      )}

      {/* Hovered date, as a pill that rolls between values. */}
      {showAxes && activeDate && (
        <div
          ref={pillRef}
          className="pointer-events-none absolute z-40 w-fit overflow-hidden rounded-full bg-[#2c1a0e] px-4 py-1 text-sm text-[#fdf6ec] shadow-lg"
          style={{ left: pillLeft, top: PAD_TOP + plotH + 4, transition: FOLLOW_PILL }}
        >
          <RollingText
            label={headingFor(activeDate)}
            reels={[
              { values: monthValues, index: monthIndex },
              { values: dayValues, index: active ?? 0 },
            ]}
          />
        </div>
      )}

      {activePoint && activeDate && (
        <div
          ref={tipRef}
          className="pointer-events-none absolute z-50 w-fit"
          style={{ left: tipLeft, top: PAD_TOP + 4, transition: FOLLOW_TOOLTIP }}
        >
          <ChartTooltip
            heading={headingFor(activeDate)}
            rows={[{ name, value: format(activePoint.value), color }]}
          />
        </div>
      )}
    </div>
  );
}

export { REEL_HEIGHT };
