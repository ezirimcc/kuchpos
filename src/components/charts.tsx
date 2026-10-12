import { Decimal } from "@/lib/decimal";

/**
 * Simple charts drawn by the app itself (C69) — no chart library. They are pictures of
 * figures already on the screen: every chart sits beside a table that holds the same numbers,
 * so nothing is shown here that is not also in the table (and in the export).
 *
 * Amounts arrive as exact decimal text. They are only ever compared with each other here, to
 * work out how tall or wide a bar is as a share of the largest; no money arithmetic is done.
 */

export type ChartPoint = {
  /** Under the bar, or beside it. */
  label: string;
  /** The amount, as exact decimal text ("12500.00"). Below zero is drawn as nothing. */
  value: string;
  /** The amount as people read it ("₦12,500.00"); shown on the bar or when the pointer rests on it. */
  shown: string;
};

/** How much of the largest this value is, as a percentage with two decimal places. */
function share(value: string, largest: Decimal): string {
  if (largest.isZero()) return "0";
  return Decimal.max(new Decimal(value), 0).times(100).dividedBy(largest).toFixed(2);
}
const largestOf = (points: ChartPoint[]) => points.reduce((most, point) => Decimal.max(most, new Decimal(point.value)), new Decimal(0));

function Frame({ title, note, testId, children }: { title: string; note?: string; testId?: string; children: React.ReactNode }) {
  return (
    <figure className="rounded-3xl bg-card p-5 dark:border dark:border-border" data-testid={testId ?? "chart"}>
      <figcaption className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">{title}</span>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </figcaption>
      {children}
    </figure>
  );
}

/**
 * Columns side by side, for amounts over time (days, months, hours of the day). With many
 * columns only some of the labels are written underneath, so that they do not run together.
 */
export function ColumnChart({ title, note, points, testId }: { title: string; note?: string; points: ChartPoint[]; testId?: string }) {
  const largest = largestOf(points);
  const every = Math.max(1, Math.ceil(points.length / 12));
  const peak = points.find((point) => new Decimal(point.value).equals(largest));
  return (
    <Frame title={title} note={note ?? (peak && !largest.isZero() ? `Highest: ${peak.shown} (${peak.label})` : undefined)} testId={testId}>
      <div className="flex h-48 items-end gap-px border-b sm:gap-0.5" role="img" aria-label={`${title}. ${points.length} columns; the figures are in the table below.`}>
        {points.map((point, index) => (
          <div key={index} className="group relative flex h-full min-w-0 flex-1 items-end" title={`${point.label}: ${point.shown}`}>
            <div className="w-full rounded-t-md bg-primary transition-opacity group-hover:opacity-70" style={{ height: `${share(point.value, largest)}%`, minHeight: new Decimal(point.value).greaterThan(0) ? "2px" : undefined }} data-testid="chart-column" />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-px text-[10px] text-muted-foreground sm:gap-0.5" aria-hidden>
        {points.map((point, index) => (
          <div key={index} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
            {index % every === 0 ? <span className="inline-block">{point.label}</span> : null}
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** Bars one under another, longest first, for comparing things: products, cashiers, ways of paying, businesses. */
export function BarList({ title, note, points, testId }: { title: string; note?: string; points: ChartPoint[]; testId?: string }) {
  const largest = largestOf(points);
  return (
    <Frame title={title} note={note} testId={testId}>
      <ul className="flex flex-col gap-2.5" aria-label={`${title}. The figures are in the table below.`}>
        {points.map((point, index) => (
          <li key={index} className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate" title={point.label}>
              {point.label}
            </span>
            <span className="h-3 rounded-full bg-muted">
              <span className="block h-3 rounded-full bg-primary" style={{ width: `${share(point.value, largest)}%` }} data-testid="chart-bar" />
            </span>
            <span className="tabular-nums text-muted-foreground">{point.shown}</span>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

/** One bar cut into parts of a whole, with a key underneath: how a total is made up. */
export function ShareBar({ title, note, parts, testId }: { title: string; note?: string; parts: (ChartPoint & { tone: 1 | 2 | 3 | 4 })[]; testId?: string }) {
  const total = parts.reduce((sum, part) => sum.plus(Decimal.max(new Decimal(part.value), 0)), new Decimal(0));
  const tones = { 1: "bg-primary", 2: "bg-amber-400", 3: "bg-orange-500", 4: "bg-destructive" } as const;
  return (
    <Frame title={title} note={note} testId={testId}>
      <div className="flex h-4 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${title}. The figures are in the boxes above and the table below.`}>
        {parts.map((part, index) => (
          <span key={index} className={tones[part.tone]} style={{ width: `${share(part.value, total)}%` }} title={`${part.label}: ${part.shown}`} data-testid="chart-share" />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {parts.map((part, index) => (
          <li key={index} className="flex items-center gap-1.5">
            <span className={`size-2.5 rounded-full ${tones[part.tone]}`} aria-hidden />
            {part.label}: <span className="tabular-nums text-foreground">{part.shown}</span>
            {total.isZero() ? "" : ` (${share(part.value, total).replace(/\.\d+$/, "")}%)`}
          </li>
        ))}
      </ul>
    </Frame>
  );
}
