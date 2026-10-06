import { ClipboardList } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterDate, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDay, nairaFromText, receiptNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listReceipts } from "@/server/business/stock";
import { StockTabs } from "../stock-tabs";

export const metadata: Metadata = { title: "Deliveries — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function ReceiptsPage({ searchParams }: PageProps<"/stock/receipts">) {
  const context = await requirePagePermission("stock.receipts.view");
  const params = await searchParams;
  const filters = { q: text(params.q), from: text(params.from), to: text(params.to) };
  const list = await listReceipts(context, { search: filters.q, from: filters.from, to: filters.to, page: text(params.page) });
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader icon={ClipboardList} title="Deliveries" description="Every delivery recorded, newest first. A corrected delivery is marked, and keeps its full history." />
      <StockTabs context={context} current="receipts" />

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search deliveries" placeholder="Supplier, product, invoice or delivery number" />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/stock/receipts" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      {list.receipts.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "No delivery matches these filters." : "No deliveries have been recorded yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Delivery</TableHead>
              <TableHead>Date received</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Went into</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Total cost</TableHead>
              <TableHead>Entered by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.receipts.map((receipt) => (
              <TableRow key={receipt.id} data-testid={`receipt-row-${receipt.number}`}>
                <TableCell className="font-medium">
                  <Link href={`/stock/receipts/${receipt.id}`} className="text-link underline-offset-4 hover:underline">
                    {receiptNumber(receipt.number)}
                  </Link>
                  {receipt.version > 1 && (
                    <Badge variant="secondary" className="ml-2">
                      Corrected
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDay(receipt.receivedOn)}
                  {receipt.backdated && (
                    <Badge variant="destructive" className="ml-2">
                      Backdated
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{receipt.supplierName}</TableCell>
                <TableCell>{receipt.locationName}</TableCell>
                <TableCell className="text-right tabular-nums">{receipt.lineCount}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{nairaFromText(receipt.totalCost)}</TableCell>
                <TableCell className="text-muted-foreground">{receipt.createdByName}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination path="/stock/receipts" params={filters} noun="deliveries" {...list} />
    </div>
  );
}
