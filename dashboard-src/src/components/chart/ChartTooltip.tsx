/**
 * The reference dashboard's floating chart tooltip: a blurred, translucent
 * panel with a muted series name on the left and the value hard-right, so a
 * column of figures stays scannable as the pointer moves.
 *
 * Structure mirrors the reference node-for-node — outer positioner, blurred
 * card, padded body, date heading, then one row per series.
 */

export interface TooltipRow {
  name: string;
  value: string;
  color: string;
}

export default function ChartTooltip({
  heading,
  rows,
}: {
  heading: string;
  rows: TooltipRow[];
}) {
  return (
    <div className="min-w-[140px] overflow-hidden rounded-lg bg-[var(--chart-tooltip-background)] text-[var(--chart-tooltip-foreground)] shadow-lg backdrop-blur-md">
      <div className="px-3 py-2.5">
        <p className="mb-2 text-xs font-medium text-[var(--chart-tooltip-foreground)]">
          {heading}
        </p>
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.name} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: r.color }}
                />
                <span className="text-sm text-[var(--chart-tooltip-muted)]">{r.name}</span>
              </span>
              <span className="text-sm font-medium tabular-nums text-[var(--chart-tooltip-foreground)]">
                {r.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
