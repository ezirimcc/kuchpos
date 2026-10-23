import { UserRoundCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { FilterDate } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Alert } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, nairaFromText } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getCustomerReport } from "@/server/business/reports";
import { ValidationError } from "@/server/errors";
import { can } from "@/server/permissions";
import { ExportLink, PeriodLinks, periodText, ReportTabs } from "../report-parts";

export const metadata: Metadata = { title: "Customer report — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function CustomerReportPage({ searchParams }: PageProps<"/reports/customers">) {
  const context = await requirePagePermission("report.sales.view");
  // Not part of the last-7-days view of a manager (C82).
  await requirePagePermission("report.pages.view");
  if (!can(context, "customer.statement.view")) redirect("/reports");
  const params = await searchParams;
  const asked = { from: text(params.from), to: text(params.to) };
  let report: Awaited<ReturnType<typeof getCustomerReport>>;
  let problem: string | null = null;
  try {
    report = await getCustomerReport(context, { ...asked, page: text(params.page) });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problem = error.message;
    report = await getCustomerReport(context);
  }
  const { period } = report;
  const named = report.newCustomers + report.returningCustomers;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={UserRoundCheck}
        title="Customer report"
        description={`${periodText(period)}. Customers with a name on the sale. Sales with no customer chosen cannot be told apart, so they are shown on their own.`}
      >
        <ExportLink context={context} report="customers" params={{ from: period.from, to: period.to }} />
      </PageHeader>
      <ReportTabs context={context} current="customers" />
      {problem && <Alert variant="destructive">{problem} Showing this month instead.</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <PeriodLinks path="/reports/customers" period={period} />
        <Suspense>
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
        </Suspense>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-brand-gradient rounded-3xl p-5 text-white">
          <p className="text-sm text-white/80">Customers who bought</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums" data-testid="kpi-buyers">
            {named}
          </p>
          <p className="mt-1 text-xs text-white/80" data-testid="kpi-new-returning">
            {report.newCustomers} new · {report.returningCustomers} returning
          </p>
        </div>
        <div className="rounded-3xl bg-card p-5 dark:border dark:border-border">
          <p className="text-sm text-muted-foreground">Bought by new / returning customers</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {nairaFromText(report.newSales)} <span className="text-muted-foreground">/</span> {nairaFromText(report.returningSales)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Walk-ins: {nairaFromText(report.walkInSales)} on {report.walkInCount} {report.walkInCount === 1 ? "sale" : "sales"}
          </p>
        </div>
        <div className="rounded-3xl bg-card p-5 dark:border dark:border-border">
          <p className="text-sm text-muted-foreground">Retention rate</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums" data-testid="kpi-retention">
            {report.retentionRate === null ? "—" : `${report.retentionRate}%`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {report.boughtBefore === 0
              ? "Nobody with a name bought in the period before."
              : `${report.cameBack} of the ${report.boughtBefore} who bought in the period before came back.`}
          </p>
        </div>
        <div className="rounded-3xl bg-card p-5 dark:border dark:border-border">
          <p className="text-sm text-muted-foreground">Average lifetime value</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums" data-testid="kpi-lifetime">
            {report.averageLifetimeValue ? nairaFromText(report.averageLifetimeValue) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {report.customersEver} {report.customersEver === 1 ? "customer has" : "customers have"} bought {nairaFromText(report.lifetimeTotal)} in all. A history, not a forecast.
          </p>
        </div>
      </div>

      {report.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">No customer with a name has bought anything yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>First bought</TableHead>
              <TableHead>Last bought</TableHead>
              <TableHead className="text-right">In this period</TableHead>
              <TableHead className="text-right">Sales in this period</TableHead>
              <TableHead className="text-right">Bought in all</TableHead>
              <TableHead className="text-right">Sales in all</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.rows.map((row) => (
              <TableRow key={row.customerId} data-testid={`customer-value-${row.name}`}>
                <TableCell className="font-medium">
                  <Link href={`/customers/${row.customerId}`} className="text-link underline-offset-4 hover:underline">
                    {row.name}
                  </Link>
                  <span className="block text-xs font-normal text-muted-foreground tabular-nums">{row.phone}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(row.firstPurchase)}</TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(row.lastPurchase)}</TableCell>
                <TableCell className="text-right tabular-nums">{row.periodVisits === 0 ? <span className="text-muted-foreground">—</span> : nairaFromText(row.periodPurchases)}</TableCell>
                <TableCell className="text-right tabular-nums">{row.periodVisits}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(row.lifetimeValue)}</TableCell>
                <TableCell className="text-right tabular-nums">{row.lifetimeVisits}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pagination path="/reports/customers" params={asked} noun="customers" {...report} />
    </div>
  );
}
