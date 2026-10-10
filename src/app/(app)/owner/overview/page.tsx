import { ChartNoAxesCombined } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { PeriodLinks, periodText } from "@/app/(app)/reports/report-parts";
import { FilterDate } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { nairaFromText } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { ValidationError } from "@/server/errors";
import { getOwnerOverview } from "@/server/platform/overview";

export const metadata: Metadata = { title: "Overview — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function OwnerOverviewPage({ searchParams }: PageProps<"/owner/overview">) {
  const context = await requirePagePermission("business.manage");
  const params = await searchParams;
  let overview: Awaited<ReturnType<typeof getOwnerOverview>>;
  let problem: string | null = null;
  try {
    overview = await getOwnerOverview(context, { from: text(params.from), to: text(params.to) });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problem = error.message;
    overview = await getOwnerOverview(context);
  }
  const { period, rows, totals } = overview;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={ChartNoAxesCombined}
        title="Overview of all businesses"
        description={`${periodText(period)}. Each business on its own row, with the same figures as its own reports. Open a business to see more.`}
      />
      {problem && <Alert variant="destructive">{problem} Showing this month instead.</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <PeriodLinks path="/owner/overview" period={period} />
        <Suspense>
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
        </Suspense>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Business</TableHead>
            <TableHead className="text-right">Sales made</TableHead>
            <TableHead className="text-right">Sales</TableHead>
            <TableHead className="text-right">Refunds</TableHead>
            <TableHead className="text-right">Net sales</TableHead>
            <TableHead className="text-right">Money received</TableHead>
            <TableHead className="text-right">Owed by customers today</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.businessId} data-testid={`overview-row-${row.name}`}>
              <TableCell className="font-medium">
                {row.name}
                {!row.active && (
                  <Badge variant="destructive" className="ml-2">
                    Deactivated
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.salesCount}</TableCell>
              <TableCell className="text-right tabular-nums">{nairaFromText(row.sales)}</TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{row.refunds === "0.00" ? "—" : `−${nairaFromText(row.refunds)}`}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{nairaFromText(row.netSales)}</TableCell>
              <TableCell className="text-right tabular-nums">{nairaFromText(row.collected)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {nairaFromText(row.owed)}
                {row.customersOwing > 0 && (
                  <span className="block text-xs text-muted-foreground">
                    {row.customersOwing} {row.customersOwing === 1 ? "customer" : "customers"}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
          <TableRow data-testid="overview-total">
            <TableCell className="font-semibold">All businesses</TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{totals.salesCount}</TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(totals.sales)}</TableCell>
            <TableCell className="text-right font-semibold tabular-nums">−{nairaFromText(totals.refunds)}</TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(totals.netSales)}</TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(totals.collected)}</TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(totals.owed)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
