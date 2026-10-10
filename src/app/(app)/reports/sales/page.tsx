import { ChartColumn } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { FilterDate, FilterSelect } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Decimal } from "@/lib/decimal";
import { formatDay, nairaFromText } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getSalesReport, type SalesGrouping } from "@/server/business/reports";
import { ValidationError } from "@/server/errors";
import { ExportLink, PeriodLinks, periodText, ReportTabs } from "../report-parts";

export const metadata: Metadata = { title: "Sales report — KuchPos" };

const GROUPS: { value: SalesGrouping; label: string; column: string }[] = [
  { value: "day", label: "By day", column: "Day" },
  { value: "product", label: "By product", column: "Product" },
  { value: "category", label: "By category", column: "Category" },
  { value: "cashier", label: "By cashier", column: "Cashier" },
  { value: "hour", label: "By hour of the day", column: "Hour" },
  { value: "method", label: "By how it was paid", column: "Paid by" },
];

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

/** "▲ 12.5% on the period before", or nothing when there is nothing to compare with. */
function Change({ now, before }: { now: string; before: string }) {
  const earlier = new Decimal(before);
  if (earlier.isZero()) return <span className="text-xs text-muted-foreground">nothing in the period before</span>;
  const change = new Decimal(now).minus(earlier).times(100).dividedBy(earlier.abs());
  const up = change.greaterThanOrEqualTo(0);
  return (
    <span className={up ? "text-xs text-emerald-700 dark:text-emerald-400" : "text-xs text-destructive"}>
      {up ? "▲" : "▼"} {change.abs().toFixed(1)}% on the period before
    </span>
  );
}

function Tile({ title, value, note, testId, highlight }: { title: string; value: string; note?: React.ReactNode; testId: string; highlight?: boolean }) {
  return (
    <div className={highlight ? "bg-brand-gradient rounded-3xl p-5 text-white" : "rounded-3xl bg-card p-5 dark:border dark:border-border"}>
      <p className={highlight ? "text-sm text-white/80" : "text-sm text-muted-foreground"}>{title}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums" data-testid={testId}>
        {value}
      </p>
      {note && <p className={highlight ? "mt-1 text-xs text-white/80 [&_span]:text-white/90" : "mt-1"}>{note}</p>}
    </div>
  );
}

export default async function SalesReportPage({ searchParams }: PageProps<"/reports/sales">) {
  const context = await requirePagePermission("report.sales.view");
  const params = await searchParams;
  const asked = { from: text(params.from), to: text(params.to), by: text(params.by) };

  let report: Awaited<ReturnType<typeof getSalesReport>>;
  let problem: string | null = null;
  try {
    report = await getSalesReport(context, asked);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problem = error.message;
    report = await getSalesReport(context, { by: asked.by });
  }
  const { summary, before, period, rows } = report;
  const group = GROUPS.find((entry) => entry.value === report.by)!;
  const largest = rows.reduce((most, row) => Decimal.max(most, new Decimal(row.net).abs()), new Decimal(0));
  const rate = (value: string | null) => (value === null ? "—" : `${value}%`);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={ChartColumn}
        title="Sales report"
        description={`${periodText(period)}. Cancelled sales are left out. A sale made without internet counts on the day it was made.`}
      >
        <ExportLink context={context} report="sales" params={{ from: period.from, to: period.to, by: report.by }} />
      </PageHeader>
      <ReportTabs context={context} current="sales" />
      {problem && <Alert variant="destructive">{problem} Showing this month instead.</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <PeriodLinks path="/reports/sales" period={period} keep={{ by: report.by === "day" ? "" : report.by }} />
        <Suspense>
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
        </Suspense>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile highlight testId="kpi-net-sales" title="Net sales" value={nairaFromText(summary.netSales)} note={<Change now={summary.netSales} before={before.netSales} />} />
        <Tile
          testId="kpi-sales-count"
          title="Number of sales"
          value={summary.salesCount.toLocaleString("en-NG")}
          note={<span className="text-xs text-muted-foreground">{before.salesCount.toLocaleString("en-NG")} in the period before</span>}
        />
        <Tile
          testId="kpi-average-sale"
          title="Average sale"
          value={summary.averageSale ? nairaFromText(summary.averageSale) : "—"}
          note={<span className="text-xs text-muted-foreground">{summary.itemsPerSale ?? "—"} items per sale</span>}
        />
        {summary.profit !== null && (
          <Tile
            testId="kpi-profit"
            title="Gross profit"
            value={nairaFromText(summary.profit)}
            note={<span className="text-xs text-muted-foreground">margin {rate(summary.margin)} · cost {nairaFromText(summary.cost ?? "0.00")}</span>}
          />
        )}
      </div>

      <dl className="grid gap-x-8 gap-y-3 rounded-3xl bg-card p-5 text-sm sm:grid-cols-2 lg:grid-cols-5 dark:border dark:border-border" data-testid="sales-breakdown">
        <div>
          <dt className="text-xs text-muted-foreground">Before discounts</dt>
          <dd className="font-medium tabular-nums">{nairaFromText(summary.beforeDiscount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Discounts ({rate(summary.discountRate)})</dt>
          <dd className="font-medium tabular-nums">−{nairaFromText(summary.discounts)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Sales</dt>
          <dd className="font-medium tabular-nums" data-testid="breakdown-sales">
            {nairaFromText(summary.sales)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            Refunds for {summary.returnsCount} {summary.returnsCount === 1 ? "return" : "returns"} ({rate(summary.returnRate)})
          </dt>
          <dd className="font-medium tabular-nums">−{nairaFromText(summary.refunds)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Net sales</dt>
          <dd className="font-semibold tabular-nums">{nairaFromText(summary.netSales)}</dd>
        </div>
      </dl>

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect name="by" label="Break down" allLabel="By day" options={GROUPS.filter((entry) => entry.value !== "day").map((entry) => ({ value: entry.value, label: entry.label }))} />
          {report.by === "category" && <span className="text-xs text-muted-foreground">Products are shown under the category they are in today.</span>}
          {report.by === "cashier" && <span className="text-xs text-muted-foreground">A return counts against the person who made the sale.</span>}
        </div>
      </Suspense>

      {rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">Nothing was sold in this period.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{group.column}</TableHead>
              <TableHead className="text-right">Sales made</TableHead>
              <TableHead className="text-right">Sales</TableHead>
              <TableHead className="text-right">Refunds</TableHead>
              <TableHead className="text-right">Net sales</TableHead>
              <TableHead className="w-40" aria-hidden />
              {report.showsCost && <TableHead className="text-right">Cost</TableHead>}
              {report.showsCost && <TableHead className="text-right">Profit</TableHead>}
              {report.showsCost && <TableHead className="text-right">Margin</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} data-testid="sales-report-row">
                <TableCell className="font-medium">{report.by === "day" ? formatDay(row.label) : row.label}</TableCell>
                <TableCell className="text-right tabular-nums">{row.salesCount}</TableCell>
                <TableCell className="text-right tabular-nums">{nairaFromText(row.sales)}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{row.refunds === "0.00" ? "—" : `−${nairaFromText(row.refunds)}`}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{nairaFromText(row.net)}</TableCell>
                <TableCell aria-hidden>
                  <span
                    className="block h-2 rounded-full bg-primary"
                    style={{ width: `${largest.isZero() ? 0 : Decimal.max(new Decimal(row.net), 0).times(100).dividedBy(largest).toFixed(0)}%` }}
                  />
                </TableCell>
                {report.showsCost && <TableCell className="text-right text-muted-foreground tabular-nums">{nairaFromText(row.cost ?? "0.00")}</TableCell>}
                {report.showsCost && <TableCell className="text-right tabular-nums">{nairaFromText(row.profit ?? "0.00")}</TableCell>}
                {report.showsCost && <TableCell className="text-right tabular-nums">{rate(row.margin)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
