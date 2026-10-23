import { BarList } from "@/components/charts";
import { HandCoins } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { FilterDate } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { nairaFromText } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getCollectionsReport } from "@/server/business/reports";
import { ValidationError } from "@/server/errors";
import { ExportLink, PeriodLinks, periodText, recentPeriods, ReportTabs } from "../report-parts";

export const metadata: Metadata = { title: "Collections report — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function CollectionsReportPage({ searchParams }: PageProps<"/reports/collections">) {
  const context = await requirePagePermission("report.collections.view");
  const params = await searchParams;
  let report: Awaited<ReturnType<typeof getCollectionsReport>>;
  let problem: string | null = null;
  try {
    report = await getCollectionsReport(context, { from: text(params.from), to: text(params.to) });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problem = error.message;
    report = await getCollectionsReport(context);
  }
  const { period, rows, totals } = report;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={HandCoins}
        title="Collections report"
        description={`${periodText(period)}. Money actually received, by payment method. A sale put on credit appears here only when the customer pays.`}
      >
        <ExportLink context={context} report="collections" params={{ from: period.from, to: period.to }} />
      </PageHeader>
      <ReportTabs context={context} current="collections" />
      {problem && <Alert variant="destructive">{problem} Showing {report.limited ? "the last 7 days" : "this month"} instead.</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <PeriodLinks path="/reports/collections" period={period} periods={report.limited ? recentPeriods() : undefined} />
        <Suspense>
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
        </Suspense>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="bg-brand-gradient rounded-3xl p-5 text-white">
          <p className="text-sm text-white/80">Net received</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums" data-testid="collections-net">
            {nairaFromText(totals.net)}
          </p>
        </div>
        <div className="rounded-3xl bg-card p-5 dark:border dark:border-border">
          <p className="text-sm text-muted-foreground">Of which in cash</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums" data-testid="collections-cash">
            {nairaFromText(report.cashNet)}
          </p>
        </div>
        <div className="rounded-3xl bg-card p-5 dark:border dark:border-border">
          <p className="text-sm text-muted-foreground">Given back (cancelled sales and returns)</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{nairaFromText(totals.refunded)}</p>
        </div>
      </div>

      {rows.length > 1 && (
        <BarList testId="collections-chart" title="Net received, by how it was paid" points={rows.map((row) => ({ label: row.methodName, value: row.net, shown: nairaFromText(row.net) }))} />
      )}

      {rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">No money was received in this period.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Paid by</TableHead>
              <TableHead className="text-right">Received for sales</TableHead>
              <TableHead className="text-right">Received against debts</TableHead>
              <TableHead className="text-right">Given back</TableHead>
              <TableHead className="text-right">Net received</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.kind}-${row.methodName}`} data-testid="collections-row">
                <TableCell className="font-medium">{row.methodName}</TableCell>
                <TableCell className="text-right tabular-nums">{nairaFromText(row.fromSales)}</TableCell>
                <TableCell className="text-right tabular-nums">{nairaFromText(row.fromDebts)}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{row.refunded === "0.00" ? "—" : `−${nairaFromText(row.refunded)}`}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{nairaFromText(row.net)}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="font-semibold">Total</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(totals.fromSales)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(totals.fromDebts)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">−{nairaFromText(totals.refunded)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(totals.net)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </div>
  );
}
