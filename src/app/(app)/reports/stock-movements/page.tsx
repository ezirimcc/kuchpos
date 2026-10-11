import { ArrowLeftRight } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { FilterDate, FilterSelect, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Alert } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, plainNumber, signedNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getStockMovements, type MovementType } from "@/server/business/reports";
import { ValidationError } from "@/server/errors";
import { ExportLink, PeriodLinks, periodText, ReportTabs } from "../report-parts";

export const metadata: Metadata = { title: "Stock movements — KuchPos" };

const TYPES: Record<MovementType, string> = {
  OPENING_BALANCE: "Opening stock (brought in)",
  RECEIPT: "Delivery received",
  RECEIPT_CORRECTION: "Delivery corrected",
  TRANSFER_OUT: "Moved out",
  TRANSFER_IN: "Moved in",
  ADJUSTMENT: "Adjustment",
  SALE: "Sold",
  SALE_CANCELLATION: "Sale cancelled",
  SALE_RETURN: "Returned by customer",
};

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function StockMovementsPage({ searchParams }: PageProps<"/reports/stock-movements">) {
  const context = await requirePagePermission("report.stock.view");
  const params = await searchParams;
  const filters = { q: text(params.q), type: text(params.type), location: text(params.location), from: text(params.from), to: text(params.to) };
  const ask = (dates: { from: string; to: string }) =>
    getStockMovements(context, { ...dates, search: filters.q, type: filters.type, location: filters.location, page: text(params.page) });
  let list: Awaited<ReturnType<typeof getStockMovements>>;
  let problem: string | null = null;
  try {
    list = await ask({ from: filters.from, to: filters.to });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problem = error.message;
    list = await ask({ from: "", to: "" });
  }
  const { period } = list;
  const kept = { q: filters.q, type: filters.type, location: filters.location };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={ArrowLeftRight}
        title="Stock movements"
        description={`${periodText(period)}. Everything that came in, went out or moved, newest first. Amounts are in each product's smallest unit.`}
      >
        <ExportLink context={context} report="stock-movements" params={{ from: period.from, to: period.to, search: filters.q, type: filters.type, location: filters.location }} />
      </PageHeader>
      <ReportTabs context={context} current="stock-movements" />
      {problem && <Alert variant="destructive">{problem} Showing this month instead.</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <PeriodLinks path="/reports/stock-movements" period={period} keep={kept} />
        <Suspense>
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
        </Suspense>
      </div>
      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search movements" placeholder="Product name or code, or document number" />
          <FilterSelect name="type" label="What happened" allLabel="Every kind of movement" options={Object.entries(TYPES).map(([value, label]) => ({ value, label }))} />
          <FilterSelect name="location" label="Place" allLabel="Shelf and Storeroom" options={list.locations.map((location) => ({ value: location.id, label: location.name }))} />
        </div>
      </Suspense>

      {list.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">No stock moved in this period that matches.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Place</TableHead>
              <TableHead>What happened</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Document</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.map((row) => (
              <TableRow key={row.id} data-testid="movement-row">
                <TableCell className="whitespace-nowrap">{formatDateTime(row.at)}</TableCell>
                <TableCell className="font-medium">
                  {row.productName}
                  {row.productCode && <span className="block text-xs font-normal text-muted-foreground">{row.productCode}</span>}
                </TableCell>
                <TableCell>{row.locationName}</TableCell>
                <TableCell>{TYPES[row.type]}</TableCell>
                <TableCell className={row.quantity.startsWith("-") ? "text-right tabular-nums" : "text-right font-medium tabular-nums"}>
                  {signedNumber(plainNumber(row.quantity))} {row.baseUnitName}
                </TableCell>
                <TableCell className="whitespace-nowrap">{row.documentNumber}</TableCell>
                <TableCell className="text-muted-foreground">{row.userName}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pagination path="/reports/stock-movements" params={filters} noun="movements" {...list} />
    </div>
  );
}
