import { ArrowLeftRight, ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterDate, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, transferNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listTransfers } from "@/server/business/transfers";
import { StockTabs } from "../stock-tabs";

export const metadata: Metadata = { title: "Transfers — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function TransfersPage({ searchParams }: PageProps<"/stock/transfers">) {
  const context = await requirePagePermission("report.stock.view");
  const params = await searchParams;
  const filters = { q: text(params.q), from: text(params.from), to: text(params.to) };
  const list = await listTransfers(context, { search: filters.q, from: filters.from, to: filters.to, page: text(params.page) });
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={ArrowLeftRight}
        title="Transfers"
        description="Every movement of stock between the Storeroom and the Shelf, newest first. A saved transfer is never changed."
      >
        {list.canTransfer && (
          <Link href="/stock/transfers/new" className={buttonVariants()}>
            <ArrowLeftRight className="size-4" aria-hidden /> New transfer
          </Link>
        )}
      </PageHeader>
      <StockTabs context={context} current="transfers" />

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search transfers" placeholder="Product, person or transfer number" />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/stock/transfers" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      {list.transfers.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "No transfer matches these filters." : "No stock has been moved between locations yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transfer</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Moved</TableHead>
              <TableHead>Products</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.transfers.map((transfer) => (
              <TableRow key={transfer.id} data-testid={`transfer-row-${transfer.number}`}>
                <TableCell className="font-medium">
                  <Link href={`/stock/transfers/${transfer.id}`} className="text-link underline-offset-4 hover:underline">
                    {transferNumber(transfer.number)}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDateTime(transfer.createdAt)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    {transfer.fromLocationName} <ArrowRight className="size-3.5 text-muted-foreground" aria-label="to" />{" "}
                    {transfer.toLocationName}
                  </span>
                </TableCell>
                <TableCell>
                  {transfer.products.join(", ")}
                  {transfer.lineCount > transfer.products.length && (
                    <span className="text-muted-foreground"> and {transfer.lineCount - transfer.products.length} more</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{transfer.createdByName}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination path="/stock/transfers" params={filters} noun="transfers" {...list} />
    </div>
  );
}
