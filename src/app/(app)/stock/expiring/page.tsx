import { CalendarClock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDay, plainNumber, receiptNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listExpiringSoon } from "@/server/business/stock";
import { StockTabs } from "../stock-tabs";

export const metadata: Metadata = { title: "Expiring soon — KuchPos" };

export default async function ExpiringPage({ searchParams }: PageProps<"/stock/expiring">) {
  const context = await requirePagePermission("report.stock.view");
  const params = await searchParams;
  const list = await listExpiringSoon(context, { page: typeof params.page === "string" ? params.page : "" });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={CalendarClock}
        title="Expiring soon"
        description={`Deliveries that expire within ${list.months} month${list.months === 1 ? "" : "s"} (by ${formatDay(list.until)}) or have already expired, for products still in stock.`}
      />
      <StockTabs context={context} current="expiring" />

      {list.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          Nothing in stock is expiring within {list.months} month{list.months === 1 ? "" : "s"}.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Expires</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">In stock now</TableHead>
              <TableHead>Delivery</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.map((row, index) => (
              <TableRow key={`${row.receiptId}-${index}`} data-testid="expiring-row">
                <TableCell className="whitespace-nowrap font-medium">
                  {formatDay(row.expiryDate)}
                  {row.expired && (
                    <Badge variant="destructive" className="ml-2">
                      Expired
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{row.productName}</TableCell>
                <TableCell>{row.batchNumber ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {plainNumber(row.quantity)} {row.unitName}
                </TableCell>
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
        Stock is not counted separately for each batch, so “In stock now” is the product’s whole stock. Use this list to
        know which batches to look for on the shelf. An admin sets how many months ahead to look, under Settings.
      </p>

      <Pagination path="/stock/expiring" params={{}} noun="deliveries" {...list} />
    </div>
  );
}
