import { BadgePercent, CloudOff, ReceiptText, ShoppingCart } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { FilterDate, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, nairaFromText } from "@/lib/format";
import { requirePageContext } from "@/server/auth/request";
import { listSales } from "@/server/business/sales";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Sales — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function SalesPage({ searchParams }: PageProps<"/sales">) {
  const context = await requirePageContext();
  if (!can(context, "report.sales.view") && !can(context, "report.ownShift.view")) redirect("/");
  const params = await searchParams;
  const filters = { q: text(params.q), from: text(params.from), to: text(params.to) };
  const list = await listSales(context, { search: filters.q, from: filters.from, to: filters.to, page: text(params.page) });
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={ReceiptText}
        title="Sales"
        description={list.ownOnly ? "The sales you have made, newest first." : "Every sale, newest first. A saved sale is never changed."}
      >
        {can(context, "report.sales.view") && (
          <Link href="/sales/offline" className={buttonVariants({ variant: "outline" })}>
            <CloudOff className="size-4" aria-hidden /> Offline exceptions
          </Link>
        )}
        {can(context, "report.discounts.view") && (
          <Link href="/sales/discounts" className={buttonVariants({ variant: "outline" })}>
            <BadgePercent className="size-4" aria-hidden /> Discounts and approvals
          </Link>
        )}
        {can(context, "sale.create") && (
          <Link href="/sell" className={buttonVariants()}>
            <ShoppingCart className="size-4" aria-hidden /> New sale
          </Link>
        )}
      </PageHeader>

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search sales" placeholder="Receipt number, product, customer or cashier" />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/sales" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      {list.sales.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "No sale matches these filters." : "No sales have been made yet."}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Products</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Served by</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.sales.map((sale) => (
                <TableRow key={sale.id} data-testid={`sale-row-${sale.receiptNumber}`}>
                  <TableCell className="font-medium whitespace-nowrap">
                    <Link href={`/sales/${sale.id}`} className="text-link underline-offset-4 hover:underline">
                      {sale.receiptNumber}
                    </Link>
                    {sale.cancelled && (
                      <Badge variant="destructive" className="ml-2">
                        Cancelled
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(sale.createdAt)}</TableCell>
                  <TableCell>
                    {sale.products.join(", ")}
                    {sale.lineCount > sale.products.length && (
                      <span className="text-muted-foreground"> and {sale.lineCount - sale.products.length} more</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {sale.customerName ?? <span className="text-muted-foreground">Walk-in</span>}
                    {sale.creditAmount !== "0.00" && <span className="block text-xs text-muted-foreground">{nairaFromText(sale.creditAmount)} on credit</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{sale.cashierName}</TableCell>
                  <TableCell className={sale.cancelled ? "text-right text-muted-foreground tabular-nums line-through" : "text-right font-medium tabular-nums"}>
                    {nairaFromText(sale.total)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="px-2 text-right text-sm text-muted-foreground">
            Total of {filtered ? "the sales that match" : "all these sales"}, leaving out cancelled ones{" "}
            <span className="ml-2 text-2xl font-semibold text-foreground tabular-nums" data-testid="sales-sum">
              {nairaFromText(list.sumOfTotals)}
            </span>
          </p>
        </>
      )}

      <Pagination path="/sales" params={filters} noun="sales" {...list} />
    </div>
  );
}
