import { CalendarClock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterSelect, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EXPIRY_MONTH_CHOICES } from "@/lib/expiry";
import { formatDay, nairaFromText, plainNumber, receiptNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listExpiringSoon } from "@/server/business/stock";
import { StockTabs } from "../stock-tabs";

export const metadata: Metadata = { title: "Expiring soon — KuchPos" };

const months = (count: number) => `${count} month${count === 1 ? "" : "s"}`;

export default async function ExpiringPage({ searchParams }: PageProps<"/stock/expiring">) {
  const context = await requirePagePermission("report.stock.view");
  const params = await searchParams;
  const text = (name: string) => (typeof params[name] === "string" ? (params[name] as string) : "");
  const filters = { q: text("q"), months: text("months"), sort: text("sort") };
  const list = await listExpiringSoon(context, { search: filters.q, months: filters.months, sort: filters.sort, page: text("page") });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={CalendarClock}
        title="Expiring soon"
        description={`Deliveries that expire within ${months(list.months)} (by ${formatDay(list.until)}) or have already expired, for products still in stock.`}
      />
      <StockTabs context={context} current="expiring" />

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search expiring stock" placeholder="Product or batch number" />
          <FilterSelect
            name="months"
            label="How far ahead to look"
            allLabel={`Within ${months(list.usualMonths)} (the usual)`}
            options={EXPIRY_MONTH_CHOICES.filter((count) => count !== list.usualMonths).map((count) => ({ value: String(count), label: `Within ${months(count)}` }))}
          />
          <FilterSelect
            name="sort"
            label="Sort"
            allLabel="Sort: expiring soonest first"
            options={[
              { value: "quantity", label: "Sort: largest quantity first" },
              ...(list.showsValue ? [{ value: "value", label: "Sort: highest value first" }] : []),
            ]}
          />
        </div>
      </Suspense>

      {list.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filters.q ? "Nothing expiring matches that search." : `Nothing in stock is expiring within ${months(list.months)}.`}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Expires</TableHead>
              <TableHead>Time left</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              {list.showsValue && <TableHead className="text-right">Value at cost</TableHead>}
              <TableHead className="text-right">In stock now</TableHead>
              <TableHead>Delivery</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.map((row, index) => (
              // Red for anything inside the business's own "expiring soon" period, or past its date.
              <TableRow key={`${row.receiptId}-${index}`} data-testid="expiring-row" data-soon={row.soon ? "yes" : "no"} className={row.soon ? "bg-destructive/10 hover:bg-destructive/15" : undefined}>
                <TableCell className={row.soon ? "font-medium whitespace-nowrap text-destructive" : "font-medium whitespace-nowrap"}>
                  {formatDay(row.expiryDate)}
                  {row.expired && (
                    <Badge variant="destructive" className="ml-2">
                      Expired
                    </Badge>
                  )}
                </TableCell>
                <TableCell className={row.soon ? "whitespace-nowrap text-destructive" : "whitespace-nowrap"}>
                  {row.expired ? "—" : row.monthsLeft === 0 ? "Under a month" : months(row.monthsLeft)}
                </TableCell>
                <TableCell>
                  <Link href={`/products/${row.productId}`} className="text-link underline-offset-4 hover:underline">
                    {row.productName}
                  </Link>
                </TableCell>
                <TableCell>{row.batchNumber ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {plainNumber(row.quantity)} {row.unitName}
                </TableCell>
                {list.showsValue && <TableCell className="text-right tabular-nums">{row.value === null ? "—" : nairaFromText(row.value)}</TableCell>}
                <TableCell className="text-right tabular-nums">
                  {plainNumber(row.stockNow)} {row.baseUnitName}
                </TableCell>
                <TableCell>
                  <Link href={`/stock/receipts/${row.receiptId}`} className="text-link underline-offset-4 hover:underline">
                    {receiptNumber(row.receiptNumber)}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">{formatDay(row.receivedOn)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="px-1 text-xs text-muted-foreground">
        Rows in red expire within {months(list.usualMonths)} — the period an admin sets under Settings — or have already expired. Stock is not counted
        separately for each batch, so “Delivered” and “Value at cost” are what came in with that batch, and “In stock now” is the product’s whole stock.
        Use this list to know which batches to look for on the shelf.
      </p>

      <Pagination path="/stock/expiring" params={filters} noun="deliveries" {...list} />
    </div>
  );
}
