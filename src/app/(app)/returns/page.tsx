import { ArrowLeft, Undo2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { FilterDate, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, nairaFromText, returnNumber } from "@/lib/format";
import { requirePageContext } from "@/server/auth/request";
import { listReturns } from "@/server/business/returns";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Returns — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function ReturnsPage({ searchParams }: PageProps<"/returns">) {
  const context = await requirePageContext();
  if (!can(context, "report.sales.view") && !can(context, "return.request")) redirect("/");
  const params = await searchParams;
  const filters = { q: text(params.q), from: text(params.from), to: text(params.to) };
  const list = await listReturns(context, { search: filters.q, from: filters.from, to: filters.to, page: text(params.page) });
  const filtered = Object.values(filters).some((value) => value !== "");
  const notFound = text(params.notfound);

  return (
    <div className="flex flex-col gap-5">
      <Link href="/sales" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Sales
      </Link>
      <PageHeader
        icon={Undo2}
        title="Returns"
        description={list.ownOnly ? "Goods you have taken back from customers, newest first." : "Goods taken back from customers, newest first. A saved return is never changed."}
      />

      {can(context, "return.request") && (
        <Card>
          <CardContent>
            {/* A plain form on purpose: it only opens the return screen for that receipt. */}
            <form action="/returns/new" method="get" className="flex flex-wrap items-end gap-3" data-testid="start-return">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="receipt">Take goods back: the number on the customer&apos;s receipt</Label>
                <Input id="receipt" name="receipt" placeholder="For example T1-000123" autoComplete="off" required className="w-64 uppercase" />
              </div>
              <Button type="submit">Find the sale</Button>
            </form>
            {notFound && (
              <Alert variant="destructive" className="mt-3" data-testid="receipt-not-found">
                No sale has the receipt number {notFound}. Check the number on the customer&apos;s receipt.
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search returns" placeholder="Receipt number, product, customer, person or reason" />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/returns" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      {list.returns.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "No return matches these filters." : "Nothing has been returned yet."}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Return</TableHead>
                <TableHead>When</TableHead>
                <TableHead>For receipt</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Taken back by</TableHead>
                <TableHead className="text-right">Refund</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.returns.map((row) => (
                <TableRow key={row.id} data-testid={`return-row-${returnNumber(row.number)}`}>
                  <TableCell className="font-medium whitespace-nowrap">
                    <Link href={`/returns/${row.id}`} className="text-link underline-offset-4 hover:underline">
                      {returnNumber(row.number)}
                    </Link>
                    {row.hasWriteOff && (
                      <Badge variant="destructive" className="ml-2">
                        Written off
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(row.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">{row.saleReceiptNumber}</TableCell>
                  <TableCell>{row.customerName ?? <span className="text-muted-foreground">Walk-in</span>}</TableCell>
                  <TableCell>{row.reason}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.createdByName}
                    {row.approvedByName !== row.createdByName && <span className="block text-xs">approved by {row.approvedByName}</span>}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{nairaFromText(row.refundTotal)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="px-2 text-right text-sm text-muted-foreground">
            Refunded on {filtered ? "the returns that match" : "all these returns"}{" "}
            <span className="ml-2 text-2xl font-semibold text-foreground tabular-nums" data-testid="returns-sum">
              {nairaFromText(list.sumOfRefunds)}
            </span>
          </p>
        </>
      )}
      <Pagination path="/returns" params={filters} noun="returns" {...list} />
    </div>
  );
}
