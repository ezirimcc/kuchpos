import { Boxes } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { FilterDate, FilterSelect, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Alert } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { nairaFromText, plainNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getStockReport } from "@/server/business/reports";
import { ValidationError } from "@/server/errors";
import { ExportLink, PeriodLinks, periodText, ReportTabs } from "../report-parts";

export const metadata: Metadata = { title: "Stock figures — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function Tile({ title, value, note, testId, highlight }: { title: string; value: string; note: string; testId: string; highlight?: boolean }) {
  return (
    <div className={highlight ? "bg-brand-gradient rounded-3xl p-5 text-white" : "rounded-3xl bg-card p-5 dark:border dark:border-border"}>
      <p className={highlight ? "text-sm text-white/80" : "text-sm text-muted-foreground"}>{title}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums" data-testid={testId}>
        {value}
      </p>
      <p className={highlight ? "mt-1 text-xs text-white/80" : "mt-1 text-xs text-muted-foreground"}>{note}</p>
    </div>
  );
}

export default async function StockReportPage({ searchParams }: PageProps<"/reports/stock">) {
  const context = await requirePagePermission("report.stock.view");
  // Not part of the last-7-days view of a manager (C82).
  await requirePagePermission("report.pages.view");
  const params = await searchParams;
  const filters = { q: text(params.q), show: text(params.show), from: text(params.from), to: text(params.to) };
  const ask = (dates: { from: string; to: string }) => getStockReport(context, { ...dates, search: filters.q, show: filters.show, page: text(params.page) });
  let report: Awaited<ReturnType<typeof getStockReport>>;
  let problem: string | null = null;
  try {
    report = await ask({ from: filters.from, to: filters.to });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problem = error.message;
    report = await ask({ from: "", to: "" });
  }
  const { period } = report;
  const seesMoney = report.stockValueNow !== null;
  const amount = (value: string, unit: string) => `${plainNumber(value)} ${unit}`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={Boxes}
        title="Stock figures"
        description={`${periodText(period)}. What sold and what sat, product by product — the ones that will run out soonest first.`}
      >
        <ExportLink context={context} report="stock" params={{ from: period.from, to: period.to, search: filters.q, show: filters.show }} />
      </PageHeader>
      <ReportTabs context={context} current="stock" />
      {problem && <Alert variant="destructive">{problem} Showing this month instead.</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <PeriodLinks path="/reports/stock" period={period} keep={{ q: filters.q, show: filters.show }} />
        <Suspense>
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
        </Suspense>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          highlight
          testId="kpi-stock-out"
          title="Out of stock on the Shelf today"
          value={`${report.noneOnShelf} of ${report.productsOnSale}`}
          note={`${report.shelfOutRate ?? "0"}% of products on sale · ${report.noneAnywhere} have none anywhere (${report.stockOutRate ?? "0"}%)`}
        />
        {seesMoney && (
          <>
            <Tile
              testId="kpi-stock-value"
              title="Stock held today, at cost"
              value={nairaFromText(report.stockValueNow!)}
              note={`${nairaFromText(report.stockValueAtStart!)} at the start of the period, ${nairaFromText(report.stockValueAtEnd!)} at the end`}
            />
            <Tile
              testId="kpi-turnover"
              title="Inventory turnover"
              value={report.turnover === null ? "—" : `${report.turnover} times`}
              note={`Cost of goods sold ${nairaFromText(report.costOfGoodsSold!)} ÷ average stock held · stock-to-sales ${report.stockToSales ?? "—"}`}
            />
            <Tile
              testId="kpi-shrinkage"
              title="Shrinkage (stock lost)"
              value={nairaFromText(report.shrinkageCost!)}
              note={`${report.shrinkageRate ?? "0"}% of net sales · downward adjustments and goods written off on return`}
            />
          </>
        )}
      </div>
      {seesMoney && (
        <p className="px-1 text-xs text-muted-foreground">
          Stock values in the past use today&apos;s average cost, so turnover and the past values are a close estimate, not exact.
        </p>
      )}

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search products" placeholder="Product name or code" />
          <FilterSelect
            name="show"
            label="Which products"
            allLabel="All products"
            options={[
              { value: "out", label: "None on the Shelf" },
              { value: "slow", label: "In stock but sold nothing" },
            ]}
          />
        </div>
      </Suspense>

      {report.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">No product matches.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Held now</TableHead>
              <TableHead className="text-right">At the start</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Sell-through</TableHead>
              <TableHead className="text-right">Days of stock left</TableHead>
              <TableHead className="text-right">Lost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.rows.map((row) => (
              <TableRow key={row.productId} data-testid={`stock-figures-${row.name}`}>
                <TableCell className="font-medium">
                  {row.name}
                  {row.code && <span className="block text-xs font-normal text-muted-foreground">{row.code}</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {amount(row.onHand, row.baseUnitName)}
                  {row.onShelf === "0.000" && <span className="block text-xs text-destructive">none on the Shelf</span>}
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{plainNumber(row.atStart)}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{plainNumber(row.received)}</TableCell>
                <TableCell className="text-right tabular-nums">{plainNumber(row.sold)}</TableCell>
                <TableCell className="text-right tabular-nums">{row.sellThrough === null ? "—" : `${row.sellThrough}%`}</TableCell>
                <TableCell className={row.daysLeft !== null && row.daysLeft.length <= 1 ? "text-right font-semibold text-destructive tabular-nums" : "text-right tabular-nums"}>
                  {row.daysLeft === null ? "—" : row.daysLeft}
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.lost === "0.000" ? <span className="text-muted-foreground">—</span> : plainNumber(row.lost)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pagination path="/reports/stock" params={filters} noun="products" {...report} />
    </div>
  );
}
