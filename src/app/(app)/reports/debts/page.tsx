import { ShareBar } from "@/components/charts";
import { Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, nairaFromText } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getDebtReport } from "@/server/business/reports";
import { ExportLink, ReportTabs } from "../report-parts";

export const metadata: Metadata = { title: "Customer debts — KuchPos" };

const amount = (value: string) => (value === "0.00" ? <span className="text-muted-foreground">—</span> : nairaFromText(value));

export default async function DebtReportPage() {
  const context = await requirePagePermission("report.customerDebt.view");
  // Not part of the last-7-days view of a manager (C82).
  await requirePagePermission("report.pages.view");
  const { rows, totals } = await getDebtReport(context);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={Users}
        title="Customer debts"
        description="Who owes what today, and for how long: counted from the day the goods were bought. The longest-owed are first."
      >
        <ExportLink context={context} report="debts" params={{}} />
      </PageHeader>
      <ReportTabs context={context} current="debts" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { title: "Owed in all", value: totals.total, testId: "debts-total", highlight: true },
          { title: "Up to 30 days", value: totals.current, testId: "debts-current" },
          { title: "31 to 60 days", value: totals.days31, testId: "debts-31" },
          { title: "61 to 90 days", value: totals.days61, testId: "debts-61" },
          { title: "Over 90 days", value: totals.older, testId: "debts-older" },
        ].map((tile) => (
          <div key={tile.title} className={tile.highlight ? "bg-brand-gradient rounded-3xl p-5 text-white" : "rounded-3xl bg-card p-5 dark:border dark:border-border"}>
            <p className={tile.highlight ? "text-sm text-white/80" : "text-sm text-muted-foreground"}>{tile.title}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums" data-testid={tile.testId}>
              {nairaFromText(tile.value)}
            </p>
          </div>
        ))}
      </div>

      {rows.length > 0 && (
        <ShareBar
          testId="debts-chart"
          title="What is owed, by how long it has been owed"
          parts={[
            { label: "Up to 30 days", value: totals.current, shown: nairaFromText(totals.current), tone: 1 },
            { label: "31 to 60 days", value: totals.days31, shown: nairaFromText(totals.days31), tone: 2 },
            { label: "61 to 90 days", value: totals.days61, shown: nairaFromText(totals.days61), tone: 3 },
            { label: "Over 90 days", value: totals.older, shown: nairaFromText(totals.older), tone: 4 },
          ]}
        />
      )}

      {rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">Nobody owes anything.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Oldest unpaid sale</TableHead>
              <TableHead className="text-right">Up to 30 days</TableHead>
              <TableHead className="text-right">31–60 days</TableHead>
              <TableHead className="text-right">61–90 days</TableHead>
              <TableHead className="text-right">Over 90 days</TableHead>
              <TableHead className="text-right">Owes in all</TableHead>
              <TableHead className="text-right">Credit limit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.customerId} data-testid={`debt-row-${row.name}`}>
                <TableCell className="font-medium">
                  <Link href={`/customers/${row.customerId}`} className="text-link underline-offset-4 hover:underline">
                    {row.name}
                  </Link>
                  <span className="block text-xs text-muted-foreground tabular-nums">{row.phone}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap">{row.oldestSale ? formatDate(row.oldestSale) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{amount(row.current)}</TableCell>
                <TableCell className="text-right tabular-nums">{amount(row.days31)}</TableCell>
                <TableCell className="text-right tabular-nums">{amount(row.days61)}</TableCell>
                <TableCell className={row.older === "0.00" ? "text-right tabular-nums" : "text-right font-medium text-destructive tabular-nums"}>{amount(row.older)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(row.total)}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{row.creditLimit ? nairaFromText(row.creditLimit) : "No credit"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
